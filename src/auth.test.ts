import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, validateMcpToken, isSensitiveTool, setAuthConfig, createRateLimiter } from './auth.js';

function createTestApp(token: string) {
  const app = express();
  app.use(authMiddleware({ authToken: token } as any));
  app.get('/test', (req, res) => res.json({ ok: true }));
  app.get('/sse', (req, res) => res.json({ sse: true }));
  app.post('/message', (req, res) => res.json({ message: true }));
  return app;
}

describe('authMiddleware', () => {
  const VALID_TOKEN = 'test-token-1234';

  it('should return 401 when no Authorization header', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Missing Authorization header' });
  });

  it('should return 401 when token is invalid', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid auth token' });
  });

  it('should return 200 when token is valid', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${VALID_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('should bypass auth for /sse endpoint', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app).get('/sse');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sse: true });
  });

  it('should bypass auth for /message endpoint', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app).post('/message');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: true });
  });

  it('should accept token without Bearer prefix', async () => {
    const app = createTestApp(VALID_TOKEN);
    const res = await request(app)
      .get('/test')
      .set('Authorization', VALID_TOKEN);
    expect(res.status).toBe(200);
  });
});

describe('validateMcpToken', () => {
  it('should return true for correct token', () => {
    setAuthConfig({ authToken: 'test-token' } as any);
    expect(validateMcpToken('test-token')).toBe(true);
  });

  it('should return false for wrong token', () => {
    setAuthConfig({ authToken: 'test-token' } as any);
    expect(validateMcpToken('wrong')).toBe(false);
  });

  it('should return false for undefined token', () => {
    setAuthConfig({ authToken: 'test-token' } as any);
    expect(validateMcpToken(undefined)).toBe(false);
  });

  it('should return false for empty string token', () => {
    setAuthConfig({ authToken: 'test-token' } as any);
    expect(validateMcpToken('')).toBe(false);
  });

  it('should return false when config is not set', () => {
    setAuthConfig(null as any);
    expect(validateMcpToken('anything')).toBe(false);
  });
});

describe('isSensitiveTool', () => {
  it('should return true for warpgate_add_target', () => {
    expect(isSensitiveTool('warpgate_add_target')).toBe(true);
  });

  it('should return true for warpgate_edit_target', () => {
    expect(isSensitiveTool('warpgate_edit_target')).toBe(true);
  });

  it('should return true for warpgate_remove_target', () => {
    expect(isSensitiveTool('warpgate_remove_target')).toBe(true);
  });

  it('should return false for non-sensitive tools', () => {
    expect(isSensitiveTool('warpgate_list_targets')).toBe(false);
    expect(isSensitiveTool('warpgate_exec')).toBe(false);
    expect(isSensitiveTool('warpgate_get_target')).toBe(false);
  });

  it('should return false for unknown tools', () => {
    expect(isSensitiveTool('unknown_tool')).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('should allow requests within limit', () => {
    const limiter = createRateLimiter(3);
    expect(limiter.check('test-ip')).toBe(true);
    expect(limiter.check('test-ip')).toBe(true);
    expect(limiter.check('test-ip')).toBe(true);
  });

  it('should block requests exceeding limit', () => {
    const limiter = createRateLimiter(3);
    limiter.check('test-ip');
    limiter.check('test-ip');
    limiter.check('test-ip');
    expect(limiter.check('test-ip')).toBe(false);
  });

  it('should allow different IPs independently', () => {
    const limiter = createRateLimiter(2);
    expect(limiter.check('ip-a')).toBe(true);
    expect(limiter.check('ip-a')).toBe(true);
    expect(limiter.check('ip-b')).toBe(true);  // Different IP, fresh bucket
    expect(limiter.check('ip-a')).toBe(false);  // ip-a exhausted
  });

  it('should reset bucket', () => {
    const limiter = createRateLimiter(1);
    expect(limiter.check('test-ip')).toBe(true);
    expect(limiter.check('test-ip')).toBe(false);
    limiter.reset('test-ip');
    expect(limiter.check('test-ip')).toBe(true);  // reset, should allow
  });
});
