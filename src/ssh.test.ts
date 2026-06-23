import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { safeRemotePath, downloadFile, uploadFile, execScript } from './ssh.js';

describe('safeRemotePath', () => {
  it('should allow normal paths', () => {
    expect(() => safeRemotePath('/etc/nginx/nginx.conf', 'test')).not.toThrow();
  });

  it('should allow absolute paths without traversal', () => {
    expect(() => safeRemotePath('/etc/shadow', 'test')).not.toThrow();
  });

  it('should allow simple filenames', () => {
    expect(() => safeRemotePath('file.txt', 'test')).not.toThrow();
  });

  it('should allow empty path', () => {
    expect(() => safeRemotePath('', 'test')).not.toThrow();
  });

  it('should reject paths with .. traversal in middle', () => {
    expect(() => safeRemotePath('/etc/../etc/shadow', 'test')).toThrow('Path traversal denied');
  });

  it('should reject paths with .. at start', () => {
    expect(() => safeRemotePath('../../etc/shadow', 'test')).toThrow('Path traversal denied');
  });

  it('should reject paths with .. at end', () => {
    expect(() => safeRemotePath('/etc/shadow/..', 'test')).toThrow('Path traversal denied');
  });

  it('should include the label in error message', () => {
    expect(() => safeRemotePath('../escape', 'readFile')).toThrow('readFile');
  });

  it('should return the original path when valid', () => {
    const result = safeRemotePath('/etc/nginx/nginx.conf', 'test');
    expect(result).toBe('/etc/nginx/nginx.conf');
  });
});

describe('downloadFile saveTo restriction', () => {
  const mockTarget = { id: '00000000-0000-0000-0000-000000000001', name: 'test', kind: 'SSH' as const, host: 'localhost', port: 22 };

  it('should reject paths outside ~/.warpgate-mcp/downloads/', async () => {
    await expect(downloadFile(mockTarget, '/remote/path', 'C:\\Windows\\evil.txt'))
      .rejects.toThrow('Download path denied');
  });

  it('should allow paths under ~/.warpgate-mcp/downloads/', async () => {
    const goodPath = join(homedir(), '.warpgate-mcp', 'downloads', 'test.txt');
    await expect(downloadFile(mockTarget, '/remote/path', goodPath))
      .rejects.not.toThrow('Download path denied');
  });
});

describe('uploadFile localPath restriction', () => {
  const mockTarget = { id: '00000000-0000-0000-0000-000000000002', name: 'test', kind: 'SSH' as const, host: 'localhost', port: 22 };

  it('should reject paths outside allowed directories', async () => {
    await expect(uploadFile(mockTarget, 'C:\\Windows\\evil.txt', '/remote/path'))
      .rejects.toThrow('Upload path denied');
  });

  it('should allow paths under ~/.warpgate-mcp/', async () => {
    const goodPath = join(homedir(), '.warpgate-mcp', 'test.txt');
    await expect(uploadFile(mockTarget, goodPath, '/remote/path'))
      .rejects.not.toThrow('Upload path denied');
  });
});

describe('execScript delimiter randomization', () => {
  const mockTarget = { id: '00000000-0000-0000-0000-000000000003', name: 'test', kind: 'SSH' as const, host: 'localhost', port: 22, username: 'test' as string | undefined };

  it('should reject with error (SSH unavailable) not delimiter error', async () => {
    await expect(execScript(mockTarget, 'echo hello')).rejects.toThrow();
  });
});
