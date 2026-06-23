import type { TargetInfo } from '../types.js';
import { listTargets } from '../db.js';

// ---------------------------------------------------------------------------
// warpgate_list_targets
// ---------------------------------------------------------------------------

export const listTargetsTool = {
  name: 'warpgate_list_targets',
  description: '[READONLY] List all available servers from the Warpgate bastion',
  inputSchema: {
    type: 'object',
    properties: {
      includeOffline: { type: 'boolean', description: 'Include servers marked as offline' },
      kind: { type: 'string', enum: ['SSH', 'HTTP', 'MySQL', 'Postgres'], description: 'Filter by protocol type' },
    },
  },
};

export async function handleListTargets(db: any, args: { includeOffline?: boolean; kind?: string }) {
  const targets = listTargets(db);
  let filtered = targets;

  if (args.kind) {
    filtered = filtered.filter((t: TargetInfo) => t.kind === args.kind);
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// warpgate_health_check
// ---------------------------------------------------------------------------

export const healthCheckTool = {
  name: 'warpgate_health_check',
  description: '[READONLY] Check connectivity to one or all target servers',
  inputSchema: {
    type: 'object',
    properties: {
      targetNames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific targets to check (default: all)',
      },
    },
  },
};

export async function handleHealthCheck(
  db: any,
  ssh: { exec: Function },
  args: { targetNames?: string[] },
  metricsDb: any,
) {
  const targets = listTargets(db);
  const toCheck = args.targetNames
    ? targets.filter((t: TargetInfo) => args.targetNames!.includes(t.name))
    : targets;

  if (toCheck.length === 0) {
    return { content: [{ type: 'text', text: '[]' }] };
  }

  const results = await Promise.allSettled(
    toCheck.slice(0, 5).map(async (target: TargetInfo) => {
      const start = Date.now();
      try {
        const result = await ssh.exec(target, 'echo ok', { timeout: 5000 });
        const latency = Date.now() - start;
        if (metricsDb) {
          metricsDb.prepare(
            'INSERT OR REPLACE INTO health_cache (target_name, status, latency_ms, checked_at) VALUES (?, ?, ?, ?)'
          ).run(target.name, 'online', latency, new Date().toISOString());
        }
        return {
          target: target.name,
          host: target.host,
          status: 'online',
          latency_ms: latency,
          exit_code: result.exitCode,
        };
      } catch (err) {
        const latency = Date.now() - start;
        if (metricsDb) {
          metricsDb.prepare(
            'INSERT OR REPLACE INTO health_cache (target_name, status, latency_ms, checked_at) VALUES (?, ?, ?, ?)'
          ).run(target.name, 'offline', latency, new Date().toISOString());
        }
        return {
          target: target.name,
          host: target.host,
          status: 'offline',
          latency_ms: latency,
          error: (err as Error).message,
        };
      }
    }),
  );

  return {
    content: [{ type: 'text', text: JSON.stringify(results.map(r => r.status === 'fulfilled' ? r.value : { error: (r as any).reason?.message }), null, 2) }],
  };
}
