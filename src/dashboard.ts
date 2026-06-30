import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import type { Config } from './config.js';
import type { Stats } from './stats.js';
import { handleListTargets, handleHealthCheck } from './tools/discovery.js';
import { handleStats, handleAlertList, handleAlertCreate, handleAlertDelete } from './tools/monitor.js';
import { handleAuditQuery, handleAuditStats } from './tools/audit-query.js';
import { handleDepsCheck, handleConfigGet } from './tools/system.js';
import { handleGetTarget } from './tools/target-mgmt.js';
import { listTargets } from './db.js';
import { getHealthCache } from './metrics-db.js';

export interface DashboardDeps {
  warpgateDb: Database | null;
  warpgateWriteDb: Database | null;
  metricsDb: Database | null;
  config: Config;
  stats: Stats;
  sshExec: (target: any, command: string, options?: any) => Promise<any>;
}

export function createDashboardRouter(deps: DashboardDeps): Router {
  const router = Router();

  // ─── Status ───────────────────────────────────────────

  router.get('/api/status', async (_req, res) => {
    try {
      const s = deps.stats.getStats();
      let health: any = { status: 'healthy', uptime_seconds: 0 };
      if (deps.warpgateDb) {
        health = await handleDepsCheck(deps.config, deps.warpgateDb, s.startTime, s);
        health = JSON.parse(health.content[0].text);
      }
      res.json({
        ...health,
        stats: { total_requests: s.callsTotal, failed_requests: s.callsFailed },
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Targets ──────────────────────────────────────────

  router.get('/api/targets', (_req, res) => {
    if (!deps.warpgateDb) {
      res.status(503).json({ error: 'Warpgate DB not available' });
      return;
    }
    try {
      const targets = listTargets(deps.warpgateDb as any);
      const augmented = targets.map((t: any) => {
        let health = null;
        if (deps.metricsDb) {
          try { health = getHealthCache(deps.metricsDb, t.name); } catch { /* ignore */ }
        }
        return { ...t, health };
      });
      res.json(augmented);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/targets/:name', (req, res) => {
    if (!deps.warpgateWriteDb) {
      res.status(503).json({ error: 'Warpgate DB not available' });
      return;
    }
    handleGetTarget(deps.warpgateWriteDb as any, { name: req.params.name })
      .then(result => {
        const data = JSON.parse(result.content[0].text);
        if (result.isError) { res.status(404).json(data); return; }
        res.json(data);
      })
      .catch(err => res.status(500).json({ error: err.message }));
  });

  router.post('/api/targets/:name/health', async (req, res) => {
    if (!deps.warpgateDb) {
      res.status(503).json({ error: 'Warpgate DB not available' });
      return;
    }
    try {
      const targets = listTargets(deps.warpgateDb as any).filter((t: any) => t.name === req.params.name);
      if (targets.length === 0) { res.status(404).json({ error: 'Target not found' }); return; }
      const result = await deps.sshExec(targets[0], 'echo ok', { timeout: 5000 });
      res.json({ target: req.params.name, status: 'online', exitCode: result.exitCode });
    } catch (err) {
      res.json({ target: req.params.name, status: 'offline', error: (err as Error).message });
    }
  });

  router.post('/api/targets/:name/stats/collect', async (req, res) => {
    if (!deps.warpgateDb || !deps.metricsDb) {
      res.status(503).json({ error: 'Required DB not available' });
      return;
    }
    try {
      const result = await handleStats({ target: req.params.name }, deps.warpgateDb as any);
      res.json(JSON.parse(result.content[0].text));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/targets/:name/stats', (_req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const rows = deps.metricsDb.prepare(
        'SELECT * FROM stats_history WHERE target_name = ? ORDER BY collected_at DESC LIMIT 60'
      ).all(_req.params.name);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Audit ────────────────────────────────────────────

  router.get('/api/audit', (req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const filters: any = {};
      if (req.query.target) filters.target = req.query.target;
      if (req.query.tool) filters.tool = req.query.tool;
      if (req.query.riskLevel) filters.riskLevel = req.query.riskLevel;
      filters.limit = parseInt(req.query.limit as string, 10) || 50;
      filters.offset = parseInt(req.query.offset as string, 10) || 0;
      const result = handleAuditQuery(deps.metricsDb as any, filters);
      res.json(JSON.parse(result.content[0].text));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/api/audit/stats', (_req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const result = handleAuditStats(deps.metricsDb as any);
      res.json(JSON.parse(result.content[0].text));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Alerts ───────────────────────────────────────────

  router.get('/api/alerts', (_req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const result = handleAlertList(deps.metricsDb as any);
      res.json(JSON.parse(result.content[0].text));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/api/alerts', (req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const result = handleAlertCreate(req.body, deps.metricsDb as any);
      res.json(JSON.parse(result.content[0].text));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/api/alerts/:id', (req, res) => {
    if (!deps.metricsDb) {
      res.status(503).json({ error: 'Metrics DB not available' });
      return;
    }
    try {
      const result = handleAlertDelete({ id: req.params.id }, deps.metricsDb as any);
      const data = JSON.parse(result.content[0].text);
      if (result.isError) { res.status(404).json(data); return; }
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
