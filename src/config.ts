import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getSecretStore } from './secret-store.js';

export interface Config {
  warpgateDbPath: string;
  sshKeyPath: string;
  sshStrictHostKeyChecking: boolean;
  metricsDbPath: string;
  listenPort: number;
  listenHost: string;
  /** @deprecated 不再存储在 config.json，仅从环境变量读取或运行时内存中 */
  authToken: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logDir: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

const CONFIG_DIR = join(homedir(), '.warpgate-mcp');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULTS: Config = {
  warpgateDbPath: '/opt/warpgate/data/db/db.sqlite3',
  sshKeyPath: join(homedir(), '.ssh', 'id_ed25519_warpgate'),
  sshStrictHostKeyChecking: true,
  metricsDbPath: join(CONFIG_DIR, 'metrics.db'),
  listenPort: 3100,
  listenHost: '127.0.0.1',
  authToken: '',
  logLevel: 'info',
  logDir: join(CONFIG_DIR, 'logs'),
};

// ─── 目录/文件权限工具 ─────────────────────────────────

function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
  }
}

function ensureSecureFile(file: string): void {
  if (process.platform !== 'win32') {
    try { chmodSync(file, 0o600); } catch { /* best-effort */ }
  }
}

// ─── Token 脱敏 ─────────────────────────────────────────

/** 安全的 token 脱敏，保留前缀和末4位 */
export function maskToken(token: string): string {
  if (!token || token.length < 8) return '****';
  if (token.length <= 10) {
    // 短 token：只显示首尾2位
    return token.slice(0, 2) + '****' + token.slice(-2);
  }
  // 长 token：前4后4
  return token.slice(0, 4) + '****' + token.slice(-4);
}

// ─── Token 迁移工具 ─────────────────────────────────────

/**
 * 从旧版 config.json 迁移 authToken 到 SecretStore。
 * 返回 true 表示迁移完成，false 表示无需迁移。
 */
export function migrateTokenFromConfig(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  const store = getSecretStore();
  if (store.hasToken()) return false; // 已经迁过了

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.authToken && typeof parsed.authToken === 'string' && parsed.authToken.length >= 8) {
      store.setToken(parsed.authToken);
      // 从 config.json 中移除 authToken
      delete parsed.authToken;
      writeConfigFile(parsed);
      return true;
    }
  } catch { /* 忽略损坏 */ }
  return false;
}

// ─── Config 文件读写 ────────────────────────────────────

function writeConfigFile(data: Record<string, unknown>): void {
  ensureSecureDir(CONFIG_DIR);
  const tmpPath = CONFIG_PATH + '.tmp.' + randomUUID().slice(0, 8);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  ensureSecureFile(tmpPath);
  renameSync(tmpPath, CONFIG_PATH);
  ensureSecureFile(CONFIG_PATH);
}

function readConfigFile(): Record<string, unknown> | null {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Config file ${CONFIG_PATH} is invalid JSON: ${(e as Error).message}`);
  }
}

// ─── 公共 API ────────────────────────────────────────────

export function loadConfig(): Config {
  const parsed = readConfigFile();
  const base = parsed ? { ...DEFAULTS, ...parsed } : { ...DEFAULTS };

  // 尝试从 SecretStore + 环境变量获取 token
  const store = getSecretStore();
  const storedToken = store.getToken();
  const envToken = envOverrides().authToken;

  // 优先级：环境变量 > SecretStore > config.json 旧字段 > 空
  if (envToken) {
    base.authToken = envToken;
  } else if (storedToken) {
    base.authToken = storedToken;
  } else if (parsed?.authToken) {
    // 旧版 config.json 还有 token → 自动迁移
    base.authToken = parsed.authToken as string;
  } else {
    base.authToken = '';
  }

  // 应用其他环境变量覆盖（不覆盖 authToken，上面已处理）
  const override = envOverrides();
  const { authToken: _, ...restOverrides } = override;
  return { ...base, ...restOverrides };
}

export function saveConfig(partial: Partial<Config>): Config {
  const current = readConfigFile() || { ...DEFAULTS };
  const updated = { ...current, ...partial };

  // authToken 不存入 config.json → 转到 SecretStore
  if (partial.authToken !== undefined) {
    const store = getSecretStore();
    store.setToken(partial.authToken);
    delete updated.authToken;
  }

  writeConfigFile(updated);
  return { ...DEFAULTS, ...updated, authToken: partial.authToken ?? (current as any).authToken ?? '' };
}

/** 判断是否已首次配置（SecretStore 有 token 或旧版 config.json 有 token） */
export function isConfigured(): boolean {
  const store = getSecretStore();
  if (store.hasToken()) return true;

  // 兼容旧版：config.json 里还有 authToken
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.authToken && typeof parsed.authToken === 'string' && parsed.authToken.length >= 8) {
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

/** 重置 authToken 并返回新值 */
export function resetToken(): string {
  const newToken = randomUUID();
  const store = getSecretStore();
  store.setToken(newToken);
  // 同时清理 config.json 中的旧 token 残留
  try {
    const raw = readConfigFile();
    if (raw && raw.authToken) {
      delete raw.authToken;
      writeConfigFile(raw);
    }
  } catch { /* ignore */ }
  return newToken;
}

export { CONFIG_DIR, CONFIG_PATH };

function envOverrides(): Partial<Config> {
  return {
    ...(process.env.WPG_DB_PATH ? { warpgateDbPath: process.env.WPG_DB_PATH } : {}),
    ...(process.env.WPG_SSH_KEY ? { sshKeyPath: process.env.WPG_SSH_KEY } : {}),
    ...(process.env.WPG_METRICS_DB ? { metricsDbPath: process.env.WPG_METRICS_DB } : {}),
    ...(process.env.WPG_PORT ? { listenPort: parseInt(process.env.WPG_PORT, 10) || 3100 } : {}),
    ...(process.env.WPG_HOST ? { listenHost: process.env.WPG_HOST } : {}),
    ...(process.env.WPG_AUTH_TOKEN ? { authToken: process.env.WPG_AUTH_TOKEN } : {}),
    ...(process.env.WPG_LOG_LEVEL ? { logLevel: process.env.WPG_LOG_LEVEL as Config['logLevel'] } : {}),
    ...(process.env.WPG_LOG_DIR ? { logDir: process.env.WPG_LOG_DIR } : {}),
    ...(process.env.WPG_SSH_STRICT_HOST_KEY ? { sshStrictHostKeyChecking: process.env.WPG_SSH_STRICT_HOST_KEY === 'true' } : {}),
    ...(process.env.WPG_TLS_CERT_PATH ? { tlsCertPath: process.env.WPG_TLS_CERT_PATH } : {}),
    ...(process.env.WPG_TLS_KEY_PATH ? { tlsKeyPath: process.env.WPG_TLS_KEY_PATH } : {}),
  };
}
