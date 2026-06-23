import type { Request, Response, NextFunction } from 'express';
import type { Config } from './config.js';
import { TOOL_META } from './tool-meta.js';

// SSE endpoint 白名单 — 这些路径绕过 token 检查（SDK 内部协商需要）
const SSE_WHITELIST = ['/sse', '/message'];

let currentConfig: Config | null = null;

export function setAuthConfig(config: Config): void {
  currentConfig = config;
}

/** 校验 MCP SSE 连接 token（查询参数方式） */
export function validateMcpToken(token: string | undefined): boolean {
  if (!currentConfig || !token) return false;
  return token === currentConfig.authToken;
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

export function authMiddleware(config: Config) {
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

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (token !== config.authToken) {
      res.status(401).json({ error: 'Invalid auth token' });
      return;
    }

    next();
  };
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
