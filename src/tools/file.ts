import { readFile as sshReadFile, uploadFile, downloadFile as sshDownload, editFile as sshEdit } from '../ssh.js';
import { randomUUID } from 'node:crypto';

// ─── warpgate_upload ───────────────────────────────────

export const uploadTool = {
  name: 'warpgate_upload',
  description: '[WRITE] Upload a local file to a remote server via SFTP',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      localPath: { type: 'string' },
      remotePath: { type: 'string' },
    },
    required: ['target', 'localPath', 'remotePath'],
  },
};

export async function handleUpload(
  getTarget: (name: string) => any,
  args: { target: string; localPath: string; remotePath: string },
  auditLog: (entry: any) => void,
) {
  const targetInfo = getTarget(args.target);
  if (!targetInfo) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }], isError: true };
  }
  try {
    await uploadFile(targetInfo, args.localPath, args.remotePath);
    auditLog({ id: randomUUID(), timestamp: new Date().toISOString(), tool: 'warpgate_upload', target: args.target, command: `upload ${args.localPath} → ${args.remotePath}`, exitCode: 0, durationMs: 0, riskLevel: 'medium', status: 'success' });
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, path: args.remotePath }) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}

// ─── warpgate_download ─────────────────────────────────

export const downloadTool = {
  name: 'warpgate_download',
  description: '[READONLY] Download a file from a remote server',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      remotePath: { type: 'string' },
      saveTo: { type: 'string', description: 'Local path to save file (optional)' },
    },
    required: ['target', 'remotePath'],
  },
};

export async function handleDownload(
  getTarget: (name: string) => any,
  args: { target: string; remotePath: string; saveTo?: string },
  auditLog: (entry: any) => void,
) {
  const targetInfo = getTarget(args.target);
  if (!targetInfo) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }], isError: true };
  }
  try {
    const result = await sshDownload(targetInfo, args.remotePath, args.saveTo);
    auditLog({ id: randomUUID(), timestamp: new Date().toISOString(), tool: 'warpgate_download', target: args.target, command: `download ${args.remotePath}`, exitCode: 0, durationMs: 0, riskLevel: 'low', status: 'success' });
    return { content: [{ type: 'text', text: result.length > 1_000_000 ? `File too large (${result.length} bytes). Use saveTo parameter to save to disk.` : result }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}

// ─── warpgate_read_file ────────────────────────────────

export const readFileTool = {
  name: 'warpgate_read_file',
  description: '[READONLY] View file content on a remote server',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      path: { type: 'string' },
      maxLines: { type: 'number', description: 'Max lines to return (default: all)' },
      offset: { type: 'number', description: 'Line offset to start from (1-based, default: 1)' },
    },
    required: ['target', 'path'],
  },
};

export async function handleReadFile(
  getTarget: (name: string) => any,
  args: { target: string; path: string; maxLines?: number; offset?: number },
) {
  const targetInfo = getTarget(args.target);
  if (!targetInfo) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }], isError: true };
  }
  try {
    const content = await sshReadFile(targetInfo, args.path);
    const lines = content.split('\n');
    const start = (args.offset ?? 1) - 1;
    const end = args.maxLines ? start + args.maxLines : undefined;
    const selected = lines.slice(start, end);
    const result = selected.join('\n').replace(/\n$/, '');
    return { content: [{ type: 'text', text: result || '(empty file)' }] };
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}

// ─── warpgate_edit_file ────────────────────────────────

export const editFileTool = {
  name: 'warpgate_edit_file',
  description: '[WRITE] Edit a file on a remote server with automatic .bak backup and diff audit',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string' },
      path: { type: 'string' },
      oldText: { type: 'string', description: 'Text to replace' },
      newText: { type: 'string', description: 'Replacement text' },
    },
    required: ['target', 'path', 'oldText', 'newText'],
  },
};

export async function handleEditFile(
  getTarget: (name: string) => any,
  args: { target: string; path: string; oldText: string; newText: string },
  auditLog: (entry: any) => void,
  withLock: (path: string, fn: () => Promise<void>) => Promise<void>,
) {
  const targetInfo = getTarget(args.target);
  if (!targetInfo) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: `Target "${args.target}" not found` }) }], isError: true };
  }
  
  let result: { backupPath: string; diff: string } | undefined;
  
  try {
    await withLock(args.path, async () => {
      result = await sshEdit(targetInfo, args.path, args.oldText, args.newText);
    });
    
    if (result) {
      auditLog({
        id: randomUUID(), timestamp: new Date().toISOString(),
        tool: 'warpgate_edit_file', target: args.target,
        command: `edit ${args.path}`,
        exitCode: 0, durationMs: 0,
        riskLevel: 'medium', status: 'success',
        diff: result.diff.slice(0, 2000),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ backupPath: result.backupPath, diff: result.diff }) }] };
    }
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: (err as Error).message }) }], isError: true };
  }
}
