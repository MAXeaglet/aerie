import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { exec } from '../ssh.js';
import { insertStatsSnapshot, listAlertRules, createAlertRule, deleteAlertRule } from '../metrics-db.js';
import { getTargetByName } from '../db.js';
import type { StatsSnapshot, TargetInfo } from '../types.js';

// Canonical alert metric names — snake_case to match stats_history columns.
// Both MCP tool schema and Dashboard must use these exact values.
export const ALERT_METRICS = ['cpu_percent', 'mem_percent', 'disk_percent', 'load_1m'] as const;
export type AlertMetric = typeof ALERT_METRICS[number];

const AlertCreateSchema = z.object({
  name: z.string().min(1),
  targetName: z.string().min(1),
  metric: z.enum(ALERT_METRICS),
  operator: z.enum(['gt', 'lt', 'gte', 'lte', 'eq']),
  threshold: z.number(),
  notifyMethod: z.string().optional(),
});

// ─── warpgate_stats ────────────────────────────────────

export const statsTool = {
  name: 'warpgate_stats',
  description: '[READONLY] Collect real-time performance snapshot from a target server',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
    },
    required: ['target'],
  },
};

export async function handleStats(
  args: { target: string },
  db: Database,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const targetInfo = getTargetByName(db, args.target);
  if (!targetInfo) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }],
      isError: true,
    };
  }

  // 采集命令：CPU / MEM / DISK / NET / LOAD / UPTIME
  const commands = [
    'echo "===CPU==="',
    'top -bn1 2>/dev/null | grep \'Cpu(s)\' || echo "0.0%us, 0.0%sy"',
    'echo "===MEM==="',
    'free -b 2>/dev/null | grep Mem || echo "0 0 0 0 0 0"',
    'echo "===DISK==="',
    'df -B1 / 2>/dev/null | tail -1 || echo "0 0 0 0% /"',
    'echo "===NET==="',
    'cat /proc/net/dev 2>/dev/null | grep -E \'eth0|ens|enp|eno\' || echo "eth0: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0"',
    'echo "===LOAD==="',
    'cat /proc/loadavg 2>/dev/null || echo "0.00 0.00 0.00"',
    'echo "===UPTIME==="',
    'cat /proc/uptime 2>/dev/null || echo "0 0"',
  ].join(' && ');

  const result = await exec(targetInfo as TargetInfo, commands);
  const sections: Record<string, string> = {};
  const blocks = result.stdout.split('===')
    .filter(Boolean)
    .reduce((acc: Record<string, string>, block: string) => {
      const [keyLine, ...lines] = block.trim().split('\n');
      const key = keyLine.replace('===', '').trim();
      acc[key] = lines.join('\n');
      return acc;
    }, sections);

  function safeParseFloat(val: string | undefined, defaultVal: number): number {
    if (val === undefined || val === '') return defaultVal;
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : defaultVal;
  }

  function safeParseInt(val: string | undefined, defaultVal: number): number {
    if (val === undefined || val === '') return defaultVal;
    const n = parseInt(val, 10);
    return Number.isFinite(n) ? n : defaultVal;
  }

  // Parse CPU — top -bn1 line: "%Cpu(s):  2.3 us,  1.1 sy, ..."
  const cpuMatch = sections.CPU?.match(/([\d.]+)%?us/);
  const cpuPercent = cpuMatch ? safeParseFloat(cpuMatch[1], 0) : 0;

  // Parse MEM — free -b output: "Mem:          total     used     free   shared  buff/cache  available"
  const memParts = sections.MEM?.split(/\s+/).filter(Boolean) || [];
  const memTotal = safeParseFloat(memParts[1], 0);
  const memUsed = safeParseFloat(memParts[2], 0);
  const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  // Parse DISK — df -B1 output: "filesystem  1B-blocks   used  available  use%  mounted"
  const diskParts = sections.DISK?.split(/\s+/).filter(Boolean) || [];
  const diskTotal = safeParseFloat(diskParts[1], 0);
  const diskUsed = safeParseFloat(diskParts[2], 0);
  const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

  // Parse NET — /proc/net/dev line: "eth0:  bytes packets errs drop ..."
  const netMatch = sections.NET?.match(/:\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  const netRx = netMatch ? safeParseInt(netMatch[1], 0) : 0;
  const netTx = netMatch ? safeParseInt(netMatch[2], 0) : 0;

  // Parse LOAD — /proc/loadavg: "1.23 0.89 0.67 ..."
  const loadParts = sections.LOAD?.split(/\s+/) || [];
  const load1m = safeParseFloat(loadParts[0], 0);
  const load5m = safeParseFloat(loadParts[1], 0);
  const load15m = safeParseFloat(loadParts[2], 0);

  // Parse UPTIME — /proc/uptime: "12345.67  ..."
  const uptimeSec = safeParseFloat(sections.UPTIME?.split(/\s+/)[0], 0);

  const snapshot: StatsSnapshot = {
    targetName: args.target,
    collectedAt: new Date().toISOString(),
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memTotalGb: Math.round(memTotal / (1024 ** 3) * 100) / 100,
    memUsedGb: Math.round(memUsed / (1024 ** 3) * 100) / 100,
    memPercent: Math.round(memPercent * 100) / 100,
    diskTotalGb: Math.round(diskTotal / (1024 ** 3) * 100) / 100,
    diskUsedGb: Math.round(diskUsed / (1024 ** 3) * 100) / 100,
    diskPercent: Math.round(diskPercent * 100) / 100,
    netRxBytes: netRx,
    netTxBytes: netTx,
    load1m,
    load5m,
    load15m,
    uptimeSeconds: Math.floor(uptimeSec),
  };

  // Write to metrics DB
  insertStatsSnapshot(db, snapshot);

  return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
}

// ─── warpgate_alert_list ───────────────────────────────

export const alertListTool = {
  name: 'warpgate_alert_list',
  description: '[READONLY] List all alert rules',
  inputSchema: {
    type: 'object',
    properties: {},
  },
};

export function handleAlertList(db: Database): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(listAlertRules(db), null, 2) }] };
}

// ─── warpgate_alert_create ─────────────────────────────

export const alertCreateTool = {
  name: 'warpgate_alert_create',
  description: '[WRITE] Create a new alert rule',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      targetName: { type: 'string' },
      metric: { type: 'string', enum: ALERT_METRICS },
      operator: { type: 'string', enum: ['gt', 'lt', 'gte', 'lte', 'eq'] },
      threshold: { type: 'number' },
      notifyMethod: { type: 'string', description: 'Optional notification method' },
    },
    required: ['name', 'targetName', 'metric', 'operator', 'threshold'],
  },
};

export function handleAlertCreate(
  args: { name: string; targetName: string; metric: string; operator: string; threshold: number; notifyMethod?: string },
  db: Database,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const parsed = AlertCreateSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid alert rule', details: parsed.error.flatten() }) }],
      isError: true,
    };
  }
  const rule = createAlertRule(db, {
    name: parsed.data.name,
    targetName: parsed.data.targetName,
    metric: parsed.data.metric,
    operator: parsed.data.operator,
    threshold: parsed.data.threshold,
    enabled: true,
    notifyMethod: parsed.data.notifyMethod,
  });
  return { content: [{ type: 'text', text: JSON.stringify(rule, null, 2) }] };
}

// ─── warpgate_alert_delete ─────────────────────────────

export const alertDeleteTool = {
  name: 'warpgate_alert_delete',
  description: '[WRITE] Delete an alert rule',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
    },
    required: ['id'],
  },
};

export function handleAlertDelete(
  args: { id: string },
  db: Database,
): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const deleted = deleteAlertRule(db, args.id);
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: deleted }) }],
    ...(deleted ? {} : { isError: true }),
  };
}
