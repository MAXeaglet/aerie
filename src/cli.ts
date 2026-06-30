#!/usr/bin/env node

/**
 * Aerie CLI — 配置管理和 token 重置工具
 *
 * 用法:
 *   aerie help            → 显示帮助
 *   aerie status          → 查看配置状态（token 脱敏）
 *   aerie reset-token     → 生成新 UUID token（写入 OS Keyring / 加密文件）
 *   aerie reset-token <值> → 设置指定 token（至少8位）
 *   aerie migrate         → 将旧版 config.json 中的 token 迁移到 SecretStore
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isConfigured, maskToken, CONFIG_PATH, migrateTokenFromConfig } from './config.js';
import { getSecretStore } from './secret-store.js';

const CONFIG_DIR = join(homedir(), '.warpgate-mcp');

function printHelp(): void {
  console.log(`
Aerie CLI — Warpgate MCP Server 管理工具

用法:
  aerie help                 显示此帮助
  aerie status               查看配置状态（token 脱敏）
  aerie reset-token          生成新的随机 token (UUID)
  aerie reset-token <值>     设置为指定 token（至少8位）
  aerie migrate              将旧版 config.json 中的 token 迁移到 SecretStore

Token 存储安全策略:
  1. OS Keyring (macOS Keychain / Windows Credential Manager / Linux Secret Service)
  2. 加密文件 ~/.warpgate-mcp/secrets (AES-256-GCM, 机器密钥派生)
  config.json 不再存储 authToken。

注意: 修改 token 后需要重启 Aerie 服务才能生效。
`);
}

function showStatus(): void {
  if (!isConfigured()) {
    console.log('\n  ⚠  未配置');
    console.log(`  配置文件: ${CONFIG_PATH}`);
    console.log('  请启动 Aerie 后通过浏览器完成首次配置。\n');
    return;
  }

  const store = getSecretStore();
  const token = store.getToken();

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    console.log('\n  ✅ 已配置');
    console.log(`  配置文件:   ${CONFIG_PATH}`);
    console.log(`  安全后端:   ${store.backendName()}`);
    console.log(`  Token:      ${token ? maskToken(token) : '(环境变量)'}`);
    if (existsSync(join(CONFIG_DIR, 'secrets'))) {
      console.log(`  加密文件:   ${join(CONFIG_DIR, 'secrets')}`);
    }
    console.log(`  端口:       ${config.listenPort || 3100}`);
    console.log(`  监听地址:   ${config.listenHost || '127.0.0.1'}`);
    console.log(`  SSH 密钥:   ${config.sshKeyPath || '~/.ssh/id_ed25519_warpgate'}`);
    console.log(`  DB 路径:    ${config.warpgateDbPath || '/opt/warpgate/data/db/db.sqlite3'}`);
    console.log(`  日志级别:   ${config.logLevel || 'info'}\n`);
  } catch (e) {
    console.error('\n  ❌ 配置文件读取失败:', (e as Error).message, '\n');
  }
}

function handleResetToken(customToken?: string): void {
  if (!existsSync(CONFIG_DIR)) {
    console.error('\n  ❌ 配置目录不存在: ' + CONFIG_DIR);
    console.error('  请先启动 Aerie 服务完成首次配置。\n');
    process.exit(1);
  }

  if (!existsSync(CONFIG_PATH)) {
    console.error('\n  ❌ 配置文件不存在: ' + CONFIG_PATH);
    console.error('  请先启动 Aerie 服务完成首次配置。\n');
    process.exit(1);
  }

  const newToken = customToken || randomUUID();

  if (newToken.length < 8) {
    console.error('\n  ❌ Token 至少需要 8 位字符。\n');
    process.exit(1);
  }

  const store = getSecretStore();
  store.setToken(newToken);
  const backendName = store.backendName();

  console.log('\n  ✅ Token 已重置');
  console.log(`  新 Token: ${newToken}`);
  console.log(`  存储后端: ${backendName}`);
  console.log('  请妥善保管此 Token，重置后无法恢复查看。');
  console.log('  ⚠  请重启 Aerie 服务使更改生效 > pm2 restart aerie\n');
}

function handleMigrate(): void {
  if (!existsSync(CONFIG_PATH)) {
    console.log('\n  ℹ️  config.json 不存在，无需迁移。\n');
    return;
  }

  const store = getSecretStore();
  if (store.hasToken()) {
    console.log('\n  ℹ️  SecretStore 已有 token，无需迁移。\n');
    return;
  }

  if (migrateTokenFromConfig()) {
    console.log('\n  ✅ Token 已从 config.json 迁移到 ' + store.backendName());
    console.log('  config.json 中的 authToken 字段已被移除。\n');
  } else {
    console.log('\n  ℹ️  未发现可迁移的 token（config.json 中没有 authToken 或格式无效）。\n');
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'status':
      showStatus();
      break;
    case 'reset-token':
      handleResetToken(args[1]);
      break;
    case 'migrate':
      handleMigrate();
      break;
    default:
      console.error(`未知命令: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('CLI 错误:', err.message);
  process.exit(1);
});
