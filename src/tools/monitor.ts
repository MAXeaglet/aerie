import type { Database } from 'better-sqlite3';
import { exec } from '../ssh.js';
import { insertStatsSnapshot, listAlertRules, createAlertRule, deleteAlertRule } from '../metrics-db.js';
import { getTargetByName } from '../db.js';
import type { StatsSnapshot, TargetInfo } from '../types.js';

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

  // Parse CPU — top -bn1 line: "%Cpu(s):  2.3 us,  1.1 sy, ..."
  const cpuMatch = sections.CPU?.match(/([\d.]+)%?us/);
  const cpuPercent = cpuMatch ? parseFloat(cpuMatch[1]) : 0;

  // Parse MEM — free -b output: "Mem:          total     used     free   shared  buff/cache  available"
  const memParts = sections.MEM?.split(/\s+/).filter(Boolean) || [];
  const memTotal = parseFloat(memParts[1] || '0');
  const memUsed = parseFloat(memParts[2] || '0');
  const memPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  // Parse DISK — df -B1 output: "filesystem  1B-blocks   used  available  use%  mounted"
  const diskParts = sections.DISK?.split(/\s+/).filter(Boolean) || [];
  const diskTotal = parseFloat(diskParts[1] || '0');
  const diskUsed = parseFloat(diskParts[2] || '0');
  const diskPercent = diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0;

  // Parse NET — /proc/net/dev line: "eth0:  bytes packets errs drop ..."
  const netMatch = sections.NET?.match(/:\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  const netRx = netMatch ? parseInt(netMatch[1], 10) : 0;
  const netTx = netMatch ? parseInt(netMatch[2], 10) : 0;

  // Parse LOAD — /proc/loadavg: "1.23 0.89 0.67 ..."
  const loadParts = sections.LOAD?.split(/\s+/) || [];
  const load1m = parseFloat(loadParts[0] || '0');
  const load5m = parseFloat(loadParts[1] || '0');
  const load15m = parseFloat(loadParts[2] || '0');

  // Parse UPTIME — /proc/uptime: "12345.67  ..."
  const uptimeSec = parseFloat(sections.UPTIME?.split(/\s+/)[0] || '0');

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
      metric: { type: 'string', enum: ['cpuPercent', 'memPercent', 'diskPercent', 'load1m'] },
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
): { content: Array<{ type: string; text: string }> } {
  const rule = createAlertRule(db, {
    name: args.name,
    targetName: args.targetName,
    metric: args.metric,
    operator: args.operator as 'gt' | 'lt' | 'gte' | 'lte' | 'eq',
    threshold: args.threshold,
    enabled: true,
    notifyMethod: args.notifyMethod,
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
