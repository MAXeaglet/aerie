import type { Config } from '../config.js';
import { maskToken, saveConfig } from '../config.js';
import { validateSchema } from '../db.js';
import { existsSync } from 'node:fs';

// ─── warpgate_deps_check ───────────────────────────────

export const depsCheckTool = {
  name: 'warpgate_deps_check',
  description: '[READONLY] Check MCP server dependencies and health',
  inputSchema: { type: 'object', properties: {} },
};

export async function handleDepsCheck(
  config: Config,
  db: any,
  startTime: number,
  stats: { callsTotal: number; callsFailed: number },
) {
  const health: any = {
    status: 'healthy',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    stats: { total_requests: stats.callsTotal, failed_requests: stats.callsFailed },
    checks: {},
  };

  // Config check
  health.checks.config = { status: 'ok' };

  // Warpgate DB check
  try {
    const missing = validateSchema(db);
    health.checks.warpgate_db = missing.length === 0
      ? { status: 'ok' }
      : { status: 'degraded', missing_tables: missing };
  } catch (err) {
    health.checks.warpgate_db = { status: 'error', message: (err as Error).message };
    health.status = 'degraded';
  }

  // SSH key check
  health.checks.ssh_key = existsSync(config.sshKeyPath)
    ? { status: 'ok', path: config.sshKeyPath }
    : { status: 'error', message: `SSH key not found at ${config.sshKeyPath}` };

  if (health.checks.ssh_key.status !== 'ok') health.status = 'degraded';

  return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
}

// ─── warpgate_config_get ───────────────────────────────

export const configGetTool = {
  name: 'warpgate_config_get',
  description: '[READONLY] View MCP server configuration (authToken masked)',
  inputSchema: { type: 'object', properties: {} },
};

export async function handleConfigGet(config: Config) {
  const masked = {
    ...config,
    authToken: maskToken(config.authToken),
  };
  return { content: [{ type: 'text', text: JSON.stringify(masked, null, 2) }] };
}

// ─── warpgate_config_set ───────────────────────────────

const ALLOWED_CONFIG_KEYS = ['listenPort', 'listenHost', 'logLevel', 'sshStrictHostKeyChecking'] as const;
type AllowedKey = typeof ALLOWED_CONFIG_KEYS[number];

export const configSetTool = {
  name: 'warpgate_config_set',
  description: '[WRITE] Update MCP server configuration (some fields are read-only)',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', enum: ALLOWED_CONFIG_KEYS, description: 'Config key to update' },
      value: { type: 'string', description: 'New value (stringified JSON for non-string values)' },
    },
    required: ['key', 'value'],
  },
};

export async function handleConfigSet(args: { key: string; value: string }) {
  if (!ALLOWED_CONFIG_KEYS.includes(args.key as AllowedKey)) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Cannot modify "${args.key}". Allowed: ${ALLOWED_CONFIG_KEYS.join(', ')}` }) }], isError: true };
  }

  // Parse value (try JSON, fallback to string)
  let parsedValue: any = args.value;
  try { parsedValue = JSON.parse(args.value); } catch { /* keep as string */ }

  saveConfig({ [args.key]: parsedValue } as any);

  return { content: [{ type: 'text', text: JSON.stringify({ success: true, key: args.key, newValue: parsedValue }) }] };
}
