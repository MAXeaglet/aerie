/**
 * SSH/SFTP 执行器 — 封装 ssh2 实现远程命令执行和文件传输
 *
 * 每次执行创建独立 SSH 连接，不缓存连接；支持超时、Host key 校验配置。
 */

import { Client, SFTPWrapper } from 'ssh2';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { TargetInfo, ExecResult } from './types.js';

// ---------------------------------------------------------------------------
// 自定义错误类
// ---------------------------------------------------------------------------

export class SshConnectionError extends Error {
  constructor(message: string, public host: string, public port: number) {
    super(`SSH connection failed to ${host}:${port} — ${message}`);
    this.name = 'SshConnectionError';
  }
}

export class SshTimeoutError extends Error {
  constructor(host: string, timeout: number) {
    super(`SSH command timed out after ${timeout}ms on ${host}`);
    this.name = 'SshTimeoutError';
  }
}

export class SshFileNotFoundError extends Error {
  constructor(path: string, host: string) {
    super(`File not found on ${host}: ${path}`);
    this.name = 'SshFileNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// 内部选项
// ---------------------------------------------------------------------------

interface SshOptions {
  timeout?: number;
  keyPath?: string;
  strictHostKey?: boolean;
}

function resolveOptions(opts?: SshOptions): Required<Omit<SshOptions, 'timeout'>> & { timeout: number } {
  return {
    timeout: opts?.timeout ?? 30_000,
    keyPath: opts?.keyPath ?? join(homedir(), '.ssh/id_ed25519_warpgate'),
    strictHostKey: opts?.strictHostKey !== false,
  };
}

// ---------------------------------------------------------------------------
// safeRemotePath — 拒绝路径遍历
// ---------------------------------------------------------------------------

export function safeRemotePath(remotePath: string, label: string): string {
  // 在 posix.resolve 规范化前检查原始路径中是否含有 .. 目录分量
  if (remotePath.split('/').includes('..')) {
    throw new Error(`Path traversal denied: ${label} contains '..'`);
  }
  return remotePath;
}

// ---------------------------------------------------------------------------
// exec — 执行单条命令
// ---------------------------------------------------------------------------

export function exec(
  target: TargetInfo,
  command: string,
  options?: SshOptions,
): Promise<ExecResult> {
  const { timeout, keyPath, strictHostKey } = resolveOptions(options);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let stdout = '';
    let stderr = '';
    const startTime = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      conn.end();
      reject(new SshTimeoutError(target.host, timeout));
    }, timeout);

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          reject(new SshConnectionError(err.message, target.host, target.port));
          return;
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        if (stream.stderr) {
          stream.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
          });
        }

        stream.on('close', (code: number | null) => {
          clearTimeout(timer);
          conn.end();
          if (timedOut) return;
          resolve({
            stdout,
            stderr,
            exitCode: code ?? -1,
            duration: Date.now() - startTime,
          });
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timer);
      reject(new SshConnectionError(err.message, target.host, target.port));
    });

    const privateKey = readFileSync(keyPath, 'utf-8');

    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username ?? 'root',
      privateKey,
      readyTimeout: 10_000,
      hostVerifier: strictHostKey ? undefined : (() => true),
    });
  });
}

// ---------------------------------------------------------------------------
// execScript — heredoc 多行脚本
// ---------------------------------------------------------------------------

export function execScript(
  target: TargetInfo,
  script: string,
  options?: SshOptions,
): Promise<ExecResult> {
  const delimiter = `SCRIPT_${randomBytes(4).toString('hex')}`;
  const command = `bash -s << '${delimiter}'\n${script}\n${delimiter}`;
  return exec(target, command, options);
}

// ---------------------------------------------------------------------------
// withSftp — 创建 SFTP 会话（关闭时自动断开 SSH 连接）
// ---------------------------------------------------------------------------

function withSftp(
  target: TargetInfo,
  keyPath: string,
  strictHostKey: boolean,
): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new SshConnectionError(err.message, target.host, target.port));
          return;
        }

        const origEnd = sftp.end.bind(sftp);
        Object.defineProperty(sftp, 'end', {
          value: () => {
            origEnd();
            conn.end();
          },
          writable: true,
        });

        resolve(sftp);
      });
    });

    conn.on('error', (err) => {
      reject(new SshConnectionError(err.message, target.host, target.port));
    });

    const privateKey = readFileSync(keyPath, 'utf-8');

    conn.connect({
      host: target.host,
      port: target.port,
      username: target.username ?? 'root',
      privateKey,
      readyTimeout: 10_000,
      hostVerifier: strictHostKey ? undefined : (() => true),
    });
  });
}

// ---------------------------------------------------------------------------
// uploadFile — SFTP 上传
// ---------------------------------------------------------------------------

export async function uploadFile(
  target: TargetInfo,
  localPath: string,
  remotePath: string,
  options?: SshOptions,
): Promise<void> {
  const { keyPath, strictHostKey } = resolveOptions(options);
  safeRemotePath(remotePath, 'uploadFile');

  // 本地路径检查：限制在允许目录下
  const allowedDirs = [
    join(homedir(), '.warpgate-mcp'),
    process.cwd(),
  ];
  const resolvedLocal = resolve(localPath);
  const isAllowed = allowedDirs.some(dir => resolvedLocal.startsWith(dir));
  if (!isAllowed) {
    throw new Error(`Upload path denied: localPath must be under ${allowedDirs.join(' or ')}`);
  }

  const sftp = await withSftp(target, keyPath, strictHostKey);

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) => {
        err ? reject(err) : resolve();
      });
    });
  } finally {
    sftp.end();
  }
}

// ---------------------------------------------------------------------------
// downloadFile — SFTP 下载
// ---------------------------------------------------------------------------

export async function downloadFile(
  target: TargetInfo,
  remotePath: string,
  localPath?: string,
  options?: SshOptions,
): Promise<string> {
  const { keyPath, strictHostKey } = resolveOptions(options);
  safeRemotePath(remotePath, 'downloadFile');

  if (localPath) {
    const safeDownloadDir = join(homedir(), '.warpgate-mcp', 'downloads');
    const resolvedLocal = resolve(localPath);
    if (!resolvedLocal.startsWith(safeDownloadDir)) {
      throw new Error(`Download path denied: must be under ${safeDownloadDir}`);
    }

    const sftp = await withSftp(target, keyPath, strictHostKey);
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            const sftpErr = err as { code?: number };
            if (sftpErr.code === 2) {
              reject(new SshFileNotFoundError(remotePath, target.host));
            } else {
              reject(err);
            }
            return;
          }
          resolve();
        });
      });
      return localPath;
    } finally {
      sftp.end();
    }
  }

  return readFile(target, remotePath, { keyPath, strictHostKey });
}

// ---------------------------------------------------------------------------
// readFile — SFTP 读取文本内容
// ---------------------------------------------------------------------------

export async function readFile(
  target: TargetInfo,
  remotePath: string,
  options?: SshOptions,
): Promise<string> {
  const { keyPath, strictHostKey } = resolveOptions(options);
  safeRemotePath(remotePath, 'readFile');
  const sftp = await withSftp(target, keyPath, strictHostKey);

  try {
    return await new Promise<string>((resolve, reject) => {
      sftp.readFile(remotePath, (err, data) => {
        if (err) {
          const sftpErr = err as { code?: number };
          if (sftpErr.code === 2) {
            reject(new SshFileNotFoundError(remotePath, target.host));
          } else {
            reject(err);
          }
          return;
        }
        resolve(data.toString('utf-8'));
      });
    });
  } finally {
    sftp.end();
  }
}

// ---------------------------------------------------------------------------
// editFile — 安全编辑（备份 → 替换 → diff）
// ---------------------------------------------------------------------------

export async function editFile(
  target: TargetInfo,
  remotePath: string,
  oldText: string,
  newText: string,
  options?: SshOptions,
): Promise<{ backupPath: string; diff: string }> {
  const { keyPath, strictHostKey } = resolveOptions(options);
  safeRemotePath(remotePath, 'editFile');

  // 1. 读取原文件
  const content = await readFile(target, remotePath, { keyPath, strictHostKey });

  // 2. 检查 oldText 是否存在
  if (!content.includes(oldText)) {
    const preview = content.length > 50
      ? `${content.slice(0, 50)}...`
      : content;
    throw new Error(
      `oldText not found in ${remotePath}. Current content:\n${preview}`,
    );
  }

  // 3. 备份
  const backupPath = `${remotePath}.bak`;
  {
    const sftp = await withSftp(target, keyPath, strictHostKey);
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(backupPath, Buffer.from(content, 'utf-8'), (err) => {
          err ? reject(err) : resolve();
        });
      });
    } finally {
      sftp.end();
    }
  }

  // 4. 替换
  const newContent = content.replace(oldText, newText);
  {
    const sftp = await withSftp(target, keyPath, strictHostKey);
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.writeFile(remotePath, Buffer.from(newContent, 'utf-8'), (err) => {
          err ? reject(err) : resolve();
        });
      });
    } finally {
      sftp.end();
    }
  }

  // 5. 生成简单行级 diff
  const oldLines = content.split('\n');
  const newLines = newContent.split('\n');
  const diff = [
    `--- ${remotePath}`,
    `+++ ${remotePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l, i) => {
      if (l !== newLines[i]) {
        return `-${l}\n+${newLines[i]}`;
      }
      return ` ${l}`;
    }),
  ].join('\n');

  return { backupPath, diff };
}
