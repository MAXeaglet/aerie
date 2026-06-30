import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { createDashboardRouter } from './dashboard.js';
import { createStats } from './stats.js';

function createMockDeps() {
  const memDb = new Database(':memory:');
  memDb.exec(`
    CREATE TABLE IF NOT EXISTS health_cache (target_name TEXT PRIMARY KEY, status TEXT, latency_ms INTEGER, checked_at TEXT);
    CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, timestamp TEXT, tool TEXT, target TEXT, command TEXT, exit_code INTEGER, duration_ms INTEGER, risk_level TEXT, diff TEXT, status TEXT);
    CREATE TABLE IF NOT EXISTS alert_rules (id TEXT PRIMARY KEY, name TEXT, target_name TEXT, metric TEXT, operator TEXT, threshold REAL, enabled INTEGER, created_at TEXT, notify_method TEXT);
    CREATE TABLE IF NOT EXISTS stats_history (id TEXT PRIMARY KEY, target_name TEXT, collected_at TEXT, cpu_percent REAL, mem_percent REAL, disk_percent REAL, load_1m REAL, uptime_seconds INTEGER);
  `);
  const stats = createStats();
  return {
    warpgateDb: null as any,
    warpgateWriteDb: null as any,
    metricsDb: memDb as any,
    config: { listenPort: 3100, listenHost: '127.0.0.1', authToken: 'test-token' } as any,
    stats,
    sshExec: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
  };
}

describe('Dashboard REST API', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use(createDashboardRouter(createMockDeps()));
  });

  it('GET /api/status returns 200', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stats');
  });

  it('GET /api/targets returns 503 when DB unavailable', async () => {
    const res = await request(app).get('/api/targets');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('not available');
  });

  it('GET /api/audit returns empty array initially', async () => {
    const res = await request(app).get('/api/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/audit/stats returns summary', async () => {
    const res = await request(app).get('/api/audit/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_calls');
    expect(res.body).toHaveProperty('by_status');
  });

  it('GET /api/alerts returns empty array', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/alerts creates and returns a rule', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .send({ name: 'test', targetName: 'srv1', metric: 'cpu_percent', operator: 'gt', threshold: 90 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('test');
    expect(res.body.metric).toBe('cpu_percent');
  });

  it('POST /api/alerts rejects invalid metric (camelCase no longer accepted)', async () => {
    const res = await request(app)
      .post('/api/alerts')
      .send({ name: 'bad', targetName: 'srv1', metric: 'cpuPercent', operator: 'gt', threshold: 90 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('error');
  });

  it('DELETE /api/alerts/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/alerts/nonexistent');
    expect(res.status).toBe(404);
  });

  it('GET /api/targets/:name/stats returns oldest→newest (ASC)', async () => {
    // Insert two snapshots out of order by collected_at
    const db = (createMockDeps() as any).metricsDb;
    const later = '2026-06-30T10:00:00Z';
    const earlier = '2026-06-30T09:00:00Z';
    db.prepare(
      'INSERT INTO stats_history (id, target_name, collected_at, cpu_percent, mem_percent, disk_percent, load_1m, uptime_seconds) VALUES (?,?,?,?,?,?,?,?)'
    ).run('1', 'srv1', later, 50, 50, 50, 1, 100);
    db.prepare(
      'INSERT INTO stats_history (id, target_name, collected_at, cpu_percent, mem_percent, disk_percent, load_1m, uptime_seconds) VALUES (?,?,?,?,?,?,?,?)'
    ).run('2', 'srv1', earlier, 10, 10, 10, 1, 100);

    // Use an app wired to the same in-memory db is hard; instead re-create router with this db
    const app2 = express();
    app2.use(express.json());
    app2.use(createDashboardRouter({
      warpgateDb: null, warpgateWriteDb: null, metricsDb: db,
      config: { listenPort: 3100, listenHost: '127.0.0.1', authToken: 't' } as any,
      stats: createStats(),
      sshExec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    const res = await request(app2).get('/api/targets/srv1/stats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
    expect(res.body[0].collected_at).toBe(earlier);
    expect(res.body[1].collected_at).toBe(later);
  });
});
