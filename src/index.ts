#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { loadConfig, isConfigured, saveConfig, resetToken, CONFIG_PATH, migrateTokenFromConfig } from './config.js';
import type { Config } from './config.js';
import { createLogger } from './logger.js';
import type { Logger } from 'pino';
import { openWarpgateDb, openWarpgateDbWritable, validateSchema } from './db.js';
import { initMetricsDb, insertAuditLog } from './metrics-db.js';
import { authMiddleware, setAuthConfig, validateMcpToken, isSensitiveTool, formatAuditEntry, loginHandler, logoutHandler } from './auth.js';
import { createStats } from './stats.js';
import type { Stats } from './stats.js';
import { exec as sshExec } from './ssh.js';
import { getTargetByName } from './db.js';
import { withEditLock } from './locks.js';
import type { Database } from 'better-sqlite3';

import { listTargetsTool, handleListTargets } from './tools/discovery.js';
import { healthCheckTool, handleHealthCheck } from './tools/discovery.js';
import { execTool, handleExec } from './tools/exec.js';
import { uploadTool, handleUpload } from './tools/file.js';
import { downloadTool, handleDownload } from './tools/file.js';
import { readFileTool, handleReadFile } from './tools/file.js';
import { editFileTool, handleEditFile } from './tools/file.js';
import { statsTool, handleStats } from './tools/monitor.js';
import { alertListTool, handleAlertList } from './tools/monitor.js';
import { alertCreateTool, handleAlertCreate } from './tools/monitor.js';
import { alertDeleteTool, handleAlertDelete } from './tools/monitor.js';
import { auditQueryTool, handleAuditQuery } from './tools/audit-query.js';
import { auditStatsTool, handleAuditStats } from './tools/audit-query.js';
import { depsCheckTool, handleDepsCheck } from './tools/system.js';
import { configGetTool, handleConfigGet } from './tools/system.js';
import { configSetTool, handleConfigSet } from './tools/system.js';
import {
  addTargetTool, handleAddTarget,
  editTargetTool, handleEditTarget,
  removeTargetTool, handleRemoveTarget,
  getTargetTool, handleGetTarget,
} from './tools/target-mgmt.js';
import { createDashboardRouter } from './dashboard.js';

// ─── 初始化（10 步）─────────────────────────────────────

// 1. loadConfig
let config: Config;
let logger: Logger;
try {
  config = loadConfig();
  setAuthConfig(config);
} catch (err) {
  // 配置文件损坏时输出到 stderr 后退出
  process.stderr.write(`FATAL: Failed to load config: ${(err as Error).message}\n`);
  process.exit(1);
}

// 2. createLogger
try {
  logger = createLogger(config);
  logger.info({ event: 'server.start', phase: 'config_loaded' });
} catch (err) {
  process.stderr.write(`FATAL: Failed to create logger: ${(err as Error).message}\n`);
  process.exit(1);
}

// 2c. 自动迁移旧版 config.json 中的 token 到 SecretStore
try {
  if (migrateTokenFromConfig()) {
    logger.info({ event: 'token.migrated', from: 'config.json', to: 'SecretStore' });
  }
  } catch {}

// 2b. 检查是否首次安装
const configured = isConfigured();
if (!configured) {
  console.log('=== Aerie Setup Mode ===');
  console.log('No config found. Open http://localhost:' + config.listenPort + ' in your browser to complete setup.');
}

// 3. createStats (在注册 handler 之前)
const stats = createStats();

// 4. validateSchema
let warpgateDb: Database | null = null;
try {
  warpgateDb = openWarpgateDb(config.warpgateDbPath) as unknown as Database;
  const missing = validateSchema(warpgateDb as any);
  if (missing.length > 0) {
    logger.warn({ event: 'schema.missing', tables: missing });
  } else {
    logger.info({ event: 'schema.valid' });
  }
} catch (err) {
  logger.error({ event: 'db.error', error: (err as Error).message });
}

// 5. initMetricsDb
let metricsDb: Database | null = null;
try {
  metricsDb = initMetricsDb(config.metricsDbPath) as Database;
  logger.info({ event: 'metrics_db.ready', path: config.metricsDbPath });
} catch (err) {
  logger.error({ event: 'metrics_db.error', error: (err as Error).message });
}

// 5b. openWarpgateDbWritable (for target management tools)
let warpgateWriteDb: Database | null = null;
try {
  warpgateWriteDb = openWarpgateDbWritable(config.warpgateDbPath) as Database;
  logger.info({ event: 'warpgate_write_db.ready', path: config.warpgateDbPath });
} catch (err) {
  logger.error({ event: 'warpgate_write_db.error', error: (err as Error).message });
}

// 6. MCP Server 实例
const server = new Server(
  { name: 'aerie', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// 7. 注册工具 handler
// Helper: 审计日志包装器
function auditLog(entry: Record<string, unknown>): void {
  if (metricsDb) {
    try { insertAuditLog(metricsDb, entry as any); } catch (err) {
      logger.warn({ event: 'audit_log.error', error: (err as Error).message });
    }
  }
}
// Helper: 获取 target 信息
function getTarget(name: string) {
  if (!warpgateDb) return null;
  return getTargetByName(warpgateDb as any, name);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    listTargetsTool, healthCheckTool,
    execTool,
    uploadTool, downloadTool, readFileTool, editFileTool,
    statsTool, alertListTool, alertCreateTool, alertDeleteTool,
    auditQueryTool, auditStatsTool,
    depsCheckTool, configGetTool, configSetTool,
    addTargetTool, editTargetTool, removeTargetTool, getTargetTool,
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  stats.incCalls();

  try {
    // I-01/RBAC: sensitive 工具检查
    if (isSensitiveTool(name)) {
      const hasConfirm = (args as Record<string, unknown>)?.confirm === true;
      logger.warn({
        event: 'sensitive_tool.call', tool: name,
        args: formatAuditEntry(name, args || {}),
        confirmed: hasConfirm,
      });
      if (!hasConfirm) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: `Sensitive tool "${name}" requires confirm=true parameter. This is a destructive operation.`,
          }) }],
          isError: true,
        };
      }
    }

    let result;
    switch (name) {
      case 'warpgate_list_targets':
        result = await handleListTargets(warpgateDb, args as any);
        break;
      case 'warpgate_health_check':
        result = await handleHealthCheck(warpgateDb, { exec: sshExec }, args as any, metricsDb);
        break;
      case 'warpgate_exec':
        result = await handleExec(getTarget, args as any, auditLog);
        break;
      case 'warpgate_upload':
        result = await handleUpload(getTarget, args as any, auditLog);
        break;
      case 'warpgate_download':
        result = await handleDownload(getTarget, args as any, auditLog);
        break;
      case 'warpgate_read_file':
        result = await handleReadFile(getTarget, args as any);
        break;
      case 'warpgate_edit_file':
        result = await handleEditFile(getTarget, args as any, auditLog, withEditLock);
        break;
      case 'warpgate_stats':
        result = await handleStats(args as any, warpgateDb as any);
        break;
      case 'warpgate_alert_list':
        result = handleAlertList(metricsDb as any);
        break;
      case 'warpgate_alert_create':
        result = handleAlertCreate(args as any, metricsDb as any);
        break;
      case 'warpgate_alert_delete':
        result = handleAlertDelete(args as any, metricsDb as any);
        break;
      case 'warpgate_audit_query':
        result = handleAuditQuery(metricsDb as any, args as any);
        break;
      case 'warpgate_audit_stats':
        result = handleAuditStats(metricsDb as any);
        break;
      case 'warpgate_deps_check':
        result = await handleDepsCheck(config, warpgateDb as any, stats.getStartTime(), stats.getStats());
        break;
      case 'warpgate_config_get':
        result = await handleConfigGet(config);
        break;
      case 'warpgate_config_set':
        result = await handleConfigSet(args as any);
        break;
      case 'warpgate_add_target':
        result = await handleAddTarget(warpgateWriteDb as any, args as any, auditLog);
        break;
      case 'warpgate_edit_target':
        result = await handleEditTarget(warpgateWriteDb as any, args as any, auditLog);
        break;
      case 'warpgate_remove_target':
        result = await handleRemoveTarget(warpgateWriteDb as any, args as any, auditLog);
        break;
      case 'warpgate_get_target':
        result = await handleGetTarget(warpgateWriteDb as any, args as any, auditLog);
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    if (result.isError) stats.incFailed();
    return result;
  } catch (err) {
    stats.incFailed();
    logger.error({ event: 'tool.error', tool: name, error: (err as Error).message });
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }],
      isError: true,
    };
  }
});

// 8. Express app + auth + dashboard
const app = express();
// Trust first proxy hop so req.ip reflects the real client when behind Nginx/OpenResty
app.set('trust proxy', 1);
const __fname = fileURLToPath(import.meta.url);
const __dname = dirname(__fname);
const dashboardDir = __dname.includes('src')
  ? join(__dname, 'dashboard')
  : join(__dname, '..', 'src', 'dashboard');

// Body parser (for dashboard login POST)
app.use(express.json());

// Dashboard static files (before auth — /dashboard/* and / are whitelisted in auth middleware)
app.use('/dashboard', express.static(dashboardDir));
app.get('/', (_req, res) => {
  res.sendFile(dashboardDir + '/index.html');
});

// Setup routes — 首次安装跳过认证（在 authMiddleware 之前）
app.get('/api/setup/status', (_req, res) => {
  res.json({ configured: isConfigured() });
});

app.post('/api/setup/init', (req, res) => {
  const { token } = req.body || {};
  if (!token || token.length < 8) {
    res.status(400).json({ error: 'Token must be at least 8 characters' });
    return;
  }
  if (isConfigured()) {
    res.status(403).json({ error: 'Already configured. Use CLI to reset token.' });
    return;
  }
  // 创建完整配置并设置 token
  const cfg = saveConfig({ authToken: token });
  setAuthConfig(cfg);
  config = cfg;
  logger.info({ event: 'setup.complete', configured: true });
  res.json({ success: true, token });
});

// Auth middleware (whitelisted paths pass through, all others need Bearer or session)
app.use(authMiddleware());

// Dashboard auth routes (whitelisted)
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/logout', logoutHandler);

// Dashboard REST API router (protected by auth middleware)
app.use(createDashboardRouter({
  warpgateDb,
  warpgateWriteDb,
  metricsDb,
  config,
  stats,
  sshExec,
}));

// 9. HTTP/SSE 传输
// /sse and /message are in the auth whitelist; /sse validates ?token itself.
let transport: SSEServerTransport | undefined;

app.get('/sse', async (req, res) => {
  const token = req.query.token as string | undefined;
  if (!validateMcpToken(token)) {
    res.status(401).json({ error: 'Unauthorized: missing or invalid ?token parameter' });
    return;
  }
  transport = new SSEServerTransport('/message', res);
  await server.connect(transport);
});

app.post('/message', async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(503).json({ error: 'SSE connection not established' });
  }
});

// 10. 启动 HTTP/HTTPS server
function startServer() {
  const handleListen = (protocol: string) => {
    logger.info({
      event: 'server.start', version: '1.0.0',
      nodeVersion: process.version,
      protocol,
      listenAddress: `${config.listenHost}:${config.listenPort}`,
      warpgateDb: config.warpgateDbPath,
      metricsDb: config.metricsDbPath,
      uptime: 0,
    });
    logger.info(`aerie v1.0.0 listening on ${config.listenHost}:${config.listenPort}${protocol === 'https' ? ' (HTTPS)' : ''}`);
  };

  const handleError = (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ event: 'server.error', error: `Port ${config.listenPort} already in use` });
    } else if (err.code === 'EACCES') {
      logger.fatal({ event: 'server.error', error: `Permission denied for port ${config.listenPort}` });
    } else {
      logger.fatal({ event: 'server.error', error: err.message });
    }
    process.exit(1);
  };

  if (config.tlsCertPath && config.tlsKeyPath) {
    const tlsOptions = {
      cert: readFileSync(config.tlsCertPath),
      key: readFileSync(config.tlsKeyPath),
    };
    const server = createHttpsServer(tlsOptions, app);
    server.on('error', handleError);
    server.listen(config.listenPort, config.listenHost, () => handleListen('https'));
  } else {
    const server = createHttpServer(app);
    server.on('error', handleError);
    server.listen(config.listenPort, config.listenHost, () => handleListen('http'));
  }
}

// 全局错误中间件（最后注册，捕获之前所有路由的异常）
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger?.error?.({ event: 'express.error', error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

startServer();
