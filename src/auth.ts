import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Config } from './config.js';
import { TOOL_META } from './tool-meta.js';

// SSE endpoint 白名单 — 这些路径绕过 token 检查（SDK 内部协商需要）
const SSE_WHITELIST = ['/sse', '/message'];

// Dashboard 白名单 — 精确匹配路径列表
const DASHBOARD_WHITELIST = ['/', '/api/auth/login', '/api/auth/logout'];
// Dashboard 前缀白名单 — 这些前缀开头的路径允许未认证访问
const DASHBOARD_WHITELIST_PREFIX = ['/dashboard/'];
// Setup 模式白名单 — 首次安装时跳过认证
const SETUP_WHITELIST = ['/api/setup/status', '/api/setup/init'];

let currentConfig: Config | null = null;

// ─── Dashboard Session Store ─────────────────────────────
const sessions = new Map<string, { createdAt: number }>();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Clean up expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 3600_000).unref();

function createSession(): string {
  const id = randomUUID();
  sessions.set(id, { createdAt: Date.now() });
  return id;
}

function validateSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function setAuthConfig(config: Config): void {
  currentConfig = config;
}

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** 校验 MCP SSE 连接 token（查询参数方式） */
export function validateMcpToken(token: string | undefined): boolean {
  if (!currentConfig || !token) return false;
  return safeCompare(token, currentConfig.authToken);
}

/** 运行时判断工具是否标记为 sensitive（I-01 RBAC 门禁） */
export function isSensitiveTool(toolName: string): boolean {
  const meta = TOOL_META.find(t => t.name === toolName);
  return meta?.sensitive === true;
}

// ─── 速率限制（令牌桶）──────────────────────────────────

export function createRateLimiter(maxPerMinute = 60) {
  const WINDOW_MS = 60_000;
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  // Clean up old buckets every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > WINDOW_MS * 2) buckets.delete(key);
    }
  }, 300_000).unref();

  return {
    check(key: string): boolean {
      const now = Date.now();
      const bucket = buckets.get(key) || { tokens: maxPerMinute, lastRefill: now };
      const elapsed = now - bucket.lastRefill;
      // Refill tokens based on elapsed time
      bucket.tokens = Math.min(maxPerMinute, bucket.tokens + (elapsed / WINDOW_MS) * maxPerMinute);
      bucket.lastRefill = now;
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return true;
    },
    reset(key: string): void {
      buckets.delete(key);
    },
  };
}

const rateLimiter = createRateLimiter(60);

export function authMiddleware(_config?: Config) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Rate limit check (before whitelist, to protect SSE too)
    if (!rateLimiter.check(req.ip || 'unknown')) {
      res.status(429).json({ error: 'Too many requests. Rate limit: 60 req/min' });
      return;
    }

    // 白名单路径跳过 token 检查
    if (SSE_WHITELIST.includes(req.path)) {
      next();
      return;
    }
    // Dashboard 白名单（先精确匹配，再前缀匹配）
    if (DASHBOARD_WHITELIST.includes(req.path) || DASHBOARD_WHITELIST_PREFIX.some(p => req.path.startsWith(p))) {
      next();
      return;
    }
    // Setup 白名单（首次安装时跳过认证）
    if (SETUP_WHITELIST.includes(req.path)) {
      next();
      return;
    }

    // Session cookie check (for dashboard API calls)
    const sessionCookie = req.headers.cookie
      ?.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('aerie_session='))
      ?.split('=')[1];
    if (sessionCookie && validateSession(sessionCookie)) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    // Use live currentConfig (kept in sync via setAuthConfig) so token changes
    // after setup take effect without server restart.
    if (!currentConfig || !safeCompare(token, currentConfig.authToken)) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
}

// ─── Dashboard Auth Handlers ─────────────────────────────

export function loginHandler(req: Request, res: Response): void {
  const { token } = req.body || {};
  if (!token || !currentConfig) {
    res.status(401).json({ error: 'Missing token' });
    return;
  }
  if (!safeCompare(token, currentConfig.authToken)) {
    res.status(401).json({ error: 'Invalid auth token' });
    return;
  }
  const sessionId = createSession();
  res.cookie('aerie_session', sessionId, {
    httpOnly: true, sameSite: 'lax', path: '/',
    maxAge: SESSION_TTL_MS,
  });
  res.json({ success: true });
}

export function logoutHandler(_req: Request, res: Response): void {
  const sessionCookie = _req.headers.cookie
    ?.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('aerie_session='))
    ?.split('=')[1];
  if (sessionCookie) destroySession(sessionCookie);
  res.cookie('aerie_session', '', {
    httpOnly: true, sameSite: 'lax', path: '/',
    maxAge: 0,
  });
  res.json({ success: true });
}

// ─── RBAC 审计格式化 ────────────────────────────────────

export function formatAuditEntry(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const entry: Record<string, unknown> = { tool: toolName };
  if (isSensitiveTool(toolName)) {
    entry.sensitive = true;
    entry.targetName = (args.name as string) || (args.id as string) || undefined;
  }
  return entry;
}
