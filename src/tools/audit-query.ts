import { queryAuditLogs } from '../metrics-db.js';

// ---------------------------------------------------------------------------
// warpgate_audit_query
// ---------------------------------------------------------------------------

export const auditQueryTool = {
  name: 'warpgate_audit_query',
  description: '[READONLY] Query MCP audit logs with optional filters',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Filter by target server name' },
      tool: { type: 'string', description: 'Filter by tool name' },
      riskLevel: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'critical'],
        description: 'Filter by risk level',
      },
      limit: { type: 'number', description: 'Max results (default 50)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
  },
};

export function handleAuditQuery(db: any, args: {
  target?: string;
  tool?: string;
  riskLevel?: string;
  limit?: number;
  offset?: number;
}) {
  const logs = queryAuditLogs(db, {
    target: args.target,
    tool: args.tool,
    riskLevel: args.riskLevel,
    limit: args.limit ?? 50,
    offset: args.offset ?? 0,
  });
  return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
}

// ---------------------------------------------------------------------------
// warpgate_audit_stats
// ---------------------------------------------------------------------------

export const auditStatsTool = {
  name: 'warpgate_audit_stats',
  description: '[READONLY] Get audit log summary statistics',
  inputSchema: { type: 'object', properties: {} },
};

export function handleAuditStats(db: any) {
  const total = (db.prepare('SELECT COUNT(*) as count FROM audit_log').get() as { count: number }).count;
  const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM audit_log GROUP BY status').all() as { status: string; count: number }[];
  const byRisk = db.prepare('SELECT risk_level, COUNT(*) as count FROM audit_log GROUP BY risk_level').all() as { risk_level: string; count: number }[];

  const success = byStatus.find((s) => s.status === 'success')?.count ?? 0;
  const failure = byStatus.find((s) => s.status === 'failure')?.count ?? 0;
  const blocked = byStatus.find((s) => s.status === 'blocked')?.count ?? 0;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        total_calls: total,
        by_status: { success, failure, blocked },
        by_risk_level: Object.fromEntries(byRisk.map((r) => [r.risk_level, r.count])),
      }, null, 2),
    }],
  };
}
