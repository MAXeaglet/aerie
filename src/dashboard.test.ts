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
      .send({ name: 'test', targetName: 'srv1', metric: 'cpuPercent', operator: 'gt', threshold: 90 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body.name).toBe('test');
  });

  it('DELETE /api/alerts/:id returns 404 for unknown id', async () => {
    const res = await request(app).delete('/api/alerts/nonexistent');
    expect(res.status).toBe(404);
  });
});
