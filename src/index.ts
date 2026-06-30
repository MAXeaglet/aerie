#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { openWarpgateDb, openWarpgateDbWritable, validateSchema } from './db.js';
import { initMetricsDb, insertAuditLog } from './metrics-db.js';
import { authMiddleware, setAuthConfig, validateMcpToken, isSensitiveTool, formatAuditEntry } from './auth.js';
import { createStats } from './stats.js';
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

// ─── 初始化（10 步）─────────────────────────────────────

// 1. loadConfig
const config = loadConfig();
setAuthConfig(config);

// 2. createLogger
const logger = createLogger(config);
logger.info({ event: 'server.start', phase: 'config_loaded' });

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
  { name: 'aerie', version: '0.1.0' },
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
    // I-01/RBAC: sensitive 工具记录审计标记
    if (isSensitiveTool(name)) {
      logger.info({ event: 'sensitive_tool.call', tool: name, args: formatAuditEntry(name, args || {}) });
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

// 8. Express app + auth middleware
const app = express();

// 9. HTTP/SSE 传输
let transport: SSEServerTransport | undefined;
app.use(authMiddleware(config));

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
  if (config.tlsCertPath && config.tlsKeyPath) {
    const tlsOptions = {
      cert: readFileSync(config.tlsCertPath),
      key: readFileSync(config.tlsKeyPath),
    };
    createHttpsServer(tlsOptions, app).listen(config.listenPort, config.listenHost, () => {
      logger.info({
        event: 'server.start', version: '0.1.0',
        nodeVersion: process.version,
        protocol: 'https',
        listenAddress: `${config.listenHost}:${config.listenPort}`,
        warpgateDb: config.warpgateDbPath,
        metricsDb: config.metricsDbPath,
        uptime: 0,
      });
      logger.info(`aerie v0.1.0 listening on ${config.listenHost}:${config.listenPort} (HTTPS)`);
    });
  } else {
    createHttpServer(app).listen(config.listenPort, config.listenHost, () => {
      logger.info({
        event: 'server.start', version: '0.1.0',
        nodeVersion: process.version,
        protocol: 'http',
        listenAddress: `${config.listenHost}:${config.listenPort}`,
        warpgateDb: config.warpgateDbPath,
        metricsDb: config.metricsDbPath,
        uptime: 0,
      });
      logger.info(`aerie v0.1.0 listening on ${config.listenHost}:${config.listenPort}`);
    });
  }
}
startServer();
