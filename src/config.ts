import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface Config {
  warpgateDbPath: string;
  sshKeyPath: string;
  sshStrictHostKeyChecking: boolean;
  metricsDbPath: string;
  listenPort: number;
  listenHost: string;
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
  authToken: randomUUID(),
  logLevel: 'info',
  logDir: join(CONFIG_DIR, 'logs'),
};

export function loadConfig(): Config {
  // 尝试从配置文件读取
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return { ...DEFAULTS, ...parsed, ...envOverrides() };
    } catch (e) {
      throw new Error(`Config file ${CONFIG_PATH} is invalid JSON: ${(e as Error).message}`);
    }
  }
  // 首次运行，创建默认配置
  const config = { ...DEFAULTS, ...envOverrides() };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* Windows 可能不支持 chmod */ }
  return config;
}

export function saveConfig(partial: Partial<Config>): Config {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
  return updated;
}

export function maskToken(_token: string): string {
  return 'warpgate-mcp-****';
}

function envOverrides(): Partial<Config> {
  return {
    ...(process.env.WPG_DB_PATH ? { warpgateDbPath: process.env.WPG_DB_PATH } : {}),
    ...(process.env.WPG_SSH_KEY ? { sshKeyPath: process.env.WPG_SSH_KEY } : {}),
    ...(process.env.WPG_METRICS_DB ? { metricsDbPath: process.env.WPG_METRICS_DB } : {}),
    ...(process.env.WPG_PORT ? { listenPort: parseInt(process.env.WPG_PORT, 10) } : {}),
    ...(process.env.WPG_HOST ? { listenHost: process.env.WPG_HOST } : {}),
    ...(process.env.WPG_AUTH_TOKEN ? { authToken: process.env.WPG_AUTH_TOKEN } : {}),
    ...(process.env.WPG_LOG_LEVEL ? { logLevel: process.env.WPG_LOG_LEVEL as Config['logLevel'] } : {}),
    ...(process.env.WPG_LOG_DIR ? { logDir: process.env.WPG_LOG_DIR } : {}),
    ...(process.env.WPG_SSH_STRICT_HOST_KEY ? { sshStrictHostKeyChecking: process.env.WPG_SSH_STRICT_HOST_KEY === 'true' } : {}),
    ...(process.env.WPG_TLS_CERT_PATH ? { tlsCertPath: process.env.WPG_TLS_CERT_PATH } : {}),
    ...(process.env.WPG_TLS_KEY_PATH ? { tlsKeyPath: process.env.WPG_TLS_KEY_PATH } : {}),
  };
}
