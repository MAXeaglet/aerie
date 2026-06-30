import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StatsSnapshot, AuditEntry, AlertRule } from './types.js';

type DB = Database.Database;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS health_cache (
  target_name TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_history (
  id TEXT PRIMARY KEY,
  target_name TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  cpu_percent REAL,
  mem_percent REAL,
  disk_percent REAL,
  load_1m REAL,
  uptime_seconds INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  tool TEXT NOT NULL,
  target TEXT,
  command TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  risk_level TEXT,
  diff TEXT,
  status TEXT
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  target_name TEXT NOT NULL,
  metric TEXT NOT NULL,
  operator TEXT NOT NULL,
  threshold REAL NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  notify_method TEXT
);
`;

export function initMetricsDb(dbPath: string): DB {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

// Health cache
export function updateHealthCache(db: DB, targetName: string, status: string, latencyMs: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO health_cache (target_name, status, latency_ms, checked_at) VALUES (?, ?, ?, ?)'
  ).run(targetName, status, latencyMs, new Date().toISOString());
}

export function getHealthCache(db: DB, targetName: string): { status: string; latency_ms: number; checked_at: string } | undefined {
  return db.prepare('SELECT status, latency_ms, checked_at FROM health_cache WHERE target_name = ?').get(targetName) as any;
}

// Stats history
export function insertStatsSnapshot(db: DB, snapshot: StatsSnapshot): void {
  db.prepare(
    'INSERT INTO stats_history (id, target_name, collected_at, cpu_percent, mem_percent, disk_percent, load_1m, uptime_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(randomUUID(), snapshot.targetName, snapshot.collectedAt, snapshot.cpuPercent, snapshot.memPercent, snapshot.diskPercent, snapshot.load1m, snapshot.uptimeSeconds);
}

export function queryStatsHistory(db: DB, targetName: string, limit = 60): any[] {
  return db.prepare(
    'SELECT * FROM stats_history WHERE target_name = ? ORDER BY collected_at DESC LIMIT ?'
  ).all(targetName, limit);
}

// Audit log
export function insertAuditLog(db: DB, entry: Omit<AuditEntry, 'id'>): void {
  db.prepare(
    'INSERT INTO audit_log (id, timestamp, tool, target, command, exit_code, duration_ms, risk_level, diff, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    randomUUID(), entry.timestamp, entry.tool, entry.target, entry.command,
    entry.exitCode, entry.durationMs, entry.riskLevel, entry.diff ?? null, entry.status
  );
}

export function queryAuditLogs(
  db: DB,
  options?: { target?: string; tool?: string; riskLevel?: string; limit?: number; offset?: number }
): any[] {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params: any[] = [];
  if (options?.target) { sql += ' AND target = ?'; params.push(options.target); }
  if (options?.tool) { sql += ' AND tool = ?'; params.push(options.tool); }
  if (options?.riskLevel) { sql += ' AND risk_level = ?'; params.push(options.riskLevel); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(options?.limit ?? 50, options?.offset ?? 0);
  return db.prepare(sql).all(...params) as any[];
}

// Alert rules
export function listAlertRules(db: DB): AlertRule[] {
  return db.prepare('SELECT * FROM alert_rules').all() as AlertRule[];
}

export function createAlertRule(db: DB, rule: Omit<AlertRule, 'id' | 'createdAt'>): AlertRule {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    'INSERT INTO alert_rules (id, name, target_name, metric, operator, threshold, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, rule.name, rule.targetName, rule.metric, rule.operator, rule.threshold, rule.enabled ? 1 : 0, createdAt);
  return { id, ...rule, createdAt } as AlertRule;
}

export function deleteAlertRule(db: DB, id: string): boolean {
  const result = db.prepare('DELETE FROM alert_rules WHERE id = ?').run(id);
  return result.changes > 0;
}
