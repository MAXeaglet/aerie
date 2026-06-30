import { z } from 'zod';

// TargetInfo — 从 Warpgate DB 读取的目标服务器信息
export const TargetInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(['SSH', 'HTTP', 'MySQL', 'Postgres']),
  host: z.string(),
  port: z.number().int().positive(),
  username: z.string().optional(),
  description: z.string().optional(),
});
export type TargetInfo = z.infer<typeof TargetInfoSchema>;

// ExecResult — 命令执行结果
export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int(),
  duration: z.number().nonnegative(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

// FileResult — 文件操作结果
export const FileResultSchema = z.object({
  success: z.boolean(),
  path: z.string(),
  content: z.string().optional(),
  backupPath: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type FileResult = z.infer<typeof FileResultSchema>;

// StatsSnapshot — 性能监控快照
export const StatsSnapshotSchema = z.object({
  targetName: z.string(),
  collectedAt: z.string().datetime(),
  cpuPercent: z.number().nonnegative(),
  memTotalGb: z.number().nonnegative(),
  memUsedGb: z.number().nonnegative(),
  memPercent: z.number().nonnegative(),
  diskTotalGb: z.number().nonnegative(),
  diskUsedGb: z.number().nonnegative(),
  diskPercent: z.number().nonnegative(),
  netRxBytes: z.number().int().nonnegative(),
  netTxBytes: z.number().int().nonnegative(),
  load1m: z.number().nonnegative(),
  load5m: z.number().nonnegative(),
  load15m: z.number().nonnegative(),
  uptimeSeconds: z.number().int().nonnegative(),
});
export type StatsSnapshot = z.infer<typeof StatsSnapshotSchema>;

// AuditEntry — 审计日志条目
export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  tool: z.string(),
  target: z.string(),
  command: z.string(),
  params: z.record(z.unknown()).optional(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  diff: z.string().optional(),
  status: z.enum(['success', 'failure', 'blocked']),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// AlertRule — 告警规则
export const AlertRuleSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  targetName: z.string(),
  metric: z.string(),
  operator: z.enum(['gt', 'lt', 'gte', 'lte', 'eq']),
  threshold: z.number(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  notifyMethod: z.string().optional(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

// TargetStatus — 服务器在线状态
export const TargetStatusSchema = z.enum(['online', 'offline', 'unknown']);
export type TargetStatus = z.infer<typeof TargetStatusSchema>;

// TargetOptions — Warpgate targets.options JSON field (SSH)
export const TargetOptionsSchema = z.object({
  kind: z.literal('Ssh'),
  host: z.string(),
  port: z.number().int().positive().default(22),
  username: z.string().default('root'),
  description: z.string().optional(),
  auth: z.object({
    kind: z.enum(['PublicKey', 'Password']),
    password: z.string().optional(),
  }),
  allow_insecure_algos: z.boolean().default(false),
  rate_limit_bytes_per_second: z.number().int().positive().optional(),
  group_id: z.string().uuid().optional(),
  ticket_max_duration_seconds: z.number().int().positive().optional(),
  ticket_requests_disabled: z.boolean().optional(),
  ticket_require_approval: z.boolean().optional(),
  ticket_max_uses: z.number().int().positive().optional(),
});
export type TargetOptions = z.infer<typeof TargetOptionsSchema>;
