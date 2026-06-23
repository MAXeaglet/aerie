import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { getAdminRoleId } from '../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidHost(host: string): boolean {
  if (!host || typeof host !== 'string') return false;
  // IPv4
  const ipv4Regex = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (ipv4Regex.test(host)) {
    // Validate each octet is 0-255
    const parts = host.split('.').map(Number);
    return parts.every(p => p >= 0 && p <= 255);
  }
  // Domain
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/;
  if (domainRegex.test(host)) return true;
  // localhost
  if (/^localhost$/i.test(host)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Tool 1: warpgate_add_target
// ---------------------------------------------------------------------------

export const addTargetTool = {
  name: 'warpgate_add_target',
  description: '[WRITE] Add a new SSH target to the Warpgate bastion',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Target name (unique identifier, used for SSH connections)' },
      host: { type: 'string', description: 'Target IP or hostname' },
      port: { type: 'number', default: 22 },
      username: { type: 'string', default: 'root' },
      description: { type: 'string' },
      auth_kind: { type: 'string', enum: ['publickey', 'password'], default: 'publickey', description: 'Authentication method' },
      auth_password: { type: 'string', description: 'Password for auth_kind=password' },
    },
    required: ['name', 'host'],
  },
};

export async function handleAddTarget(
  warpgateWriteDb: Database,
  args: Record<string, unknown>,
  auditLog: (entry: Record<string, unknown>) => void,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const name = args.name as string;
  const host = args.host as string;

  // Host format validation
  if (!isValidHost(host)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid host format. Must be a valid IP address or domain name.' }) }],
      isError: true,
    };
  }

  const port = (args.port as number) ?? 22;
  const username = (args.username as string) ?? 'root';
  const description = (args.description as string) ?? '';
  const authKind = (args.auth_kind as string) ?? 'publickey';
  const authPassword = args.auth_password as string | undefined;

  const addTargetTx = warpgateWriteDb.transaction(() => {
    // Name uniqueness check (inside transaction lock)
    const existing = warpgateWriteDb.prepare('SELECT id FROM targets WHERE name = ?').get(name);
    if (existing) {
      return { error: 'Target name already exists' };
    }

    // Auth validation
    if (authKind === 'password' && !authPassword) {
      return { error: 'auth_password is required when auth_kind=password' };
    }

    const id = randomUUID();
    const options = {
      kind: 'Ssh',
      host,
      port,
      username,
      auth: authKind === 'password'
        ? { kind: 'Password', password: authPassword }
        : { kind: 'PublicKey' },
      allow_insecure_algos: false,
    };

    warpgateWriteDb.prepare(
      'INSERT INTO targets (id, name, kind, options, description) VALUES (?, ?, ?, ?, ?)',
    ).run(id, name, 'SSH', JSON.stringify(options), description);

    // Assign admin role
    const adminRoleId = getAdminRoleId(warpgateWriteDb as any);
    if (adminRoleId) {
      warpgateWriteDb.prepare(
        'INSERT INTO target_roles (target_id, role_id) VALUES (?, ?)',
      ).run(id, adminRoleId);
    }

    return { id, name, host, port, username, auth_kind: authKind, description };
  });

  const result = addTargetTx();
  if (result.error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
      isError: true,
    };
  }

  // Audit log outside transaction (logging shouldn't block the critical path)
  auditLog({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tool: 'warpgate_add_target',
    target: name,
    command: JSON.stringify({ host, port, username, auth_kind: authKind }).slice(0, 200),
    exitCode: null,
    durationMs: 0,
    riskLevel: 'low',
    status: 'success',
    params: { targetId: result.id },
  });

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

// ---------------------------------------------------------------------------
// Tool 2: warpgate_edit_target
// ---------------------------------------------------------------------------

export const editTargetTool = {
  name: 'warpgate_edit_target',
  description: '[WRITE] Edit an existing SSH target',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target UUID' },
      name: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'number' },
      username: { type: 'string' },
      description: { type: 'string' },
      auth_kind: { type: 'string', enum: ['publickey', 'password'] },
      auth_password: { type: 'string' },
    },
    required: ['id'],
  },
};

export async function handleEditTarget(
  warpgateWriteDb: Database,
  args: Record<string, unknown>,
  auditLog: (entry: Record<string, unknown>) => void,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const id = args.id as string;

  const editTargetTx = warpgateWriteDb.transaction(() => {
    // Check target exists
    const current = warpgateWriteDb.prepare('SELECT * FROM targets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!current) {
      return { error: 'Target not found' };
    }

    // Name uniqueness when changing name
    if (args.name !== undefined) {
      const existing = warpgateWriteDb.prepare('SELECT id FROM targets WHERE name = ? AND id != ?').get(args.name, id);
      if (existing) {
        return { error: 'Target name already exists' };
      }
    }

    // Auth validation
    const authKind = args.auth_kind as string | undefined;
    const authPassword = args.auth_password as string | undefined;
    if (authKind === 'password' && !authPassword) {
      return { error: 'auth_password is required when auth_kind=password' };
    }

    // Build updated options JSON
    let currentOptions: Record<string, unknown>;
    try {
      currentOptions = JSON.parse((current.options as string) || '{}');
    } catch {
      currentOptions = {};
    }

    if (args.host !== undefined && !isValidHost(args.host as string)) {
      return { error: 'Invalid host format. Must be a valid IP address or domain name.' };
    }
    if (args.host !== undefined) currentOptions.host = args.host;
    if (args.port !== undefined) currentOptions.port = args.port;
    if (args.username !== undefined) currentOptions.username = args.username;

    if (authKind !== undefined) {
      currentOptions.auth = authKind === 'password'
        ? { kind: 'Password', password: authPassword }
        : { kind: 'PublicKey' };
    } else if (authPassword !== undefined) {
      // Only password provided without auth_kind — update password if current auth is Password
      const currentAuth = currentOptions.auth as Record<string, unknown> | undefined;
      if (currentAuth?.kind === 'Password') {
        currentAuth.password = authPassword;
      }
    }

    // Build UPDATE statement dynamically (only changed columns + options)
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (args.name !== undefined) { setClauses.push('name = ?'); values.push(args.name); }
    if (args.description !== undefined) { setClauses.push('description = ?'); values.push(args.description); }
    // Always update options since it may have changed
    setClauses.push('options = ?');
    values.push(JSON.stringify(currentOptions));
    values.push(id);

    warpgateWriteDb.prepare(
      `UPDATE targets SET ${setClauses.join(', ')} WHERE id = ?`,
    ).run(...values);

    return { currentName: current.name as string };
  });

  const txResult = editTargetTx();
  if (txResult.error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: txResult.error }) }],
      isError: true,
    };
  }

  // Audit log - exclude auth_password
  const safeArgs: Record<string, unknown> = {};
  const allowedFields = ['id', 'name', 'host', 'port', 'username', 'description', 'auth_kind'];
  for (const field of allowedFields) {
    if (args[field] !== undefined) safeArgs[field] = args[field];
  }
  auditLog({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tool: 'warpgate_edit_target',
    target: txResult.currentName,
    command: JSON.stringify(safeArgs).slice(0, 200),
    exitCode: null,
    durationMs: 0,
    riskLevel: 'low',
    status: 'success',
    params: { targetId: id },
  });

  // Return updated info
  const updated = warpgateWriteDb.prepare('SELECT * FROM targets WHERE id = ?').get(id) as Record<string, unknown>;
  const updatedOptions = JSON.parse((updated.options as string) || '{}') as Record<string, unknown>;
  const updatedAuth = updatedOptions.auth as Record<string, unknown> | undefined;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      id: updated.id,
      name: updated.name,
      host: updatedOptions.host,
      port: updatedOptions.port,
      username: updatedOptions.username,
      auth_kind: updatedAuth?.kind === 'Password' ? 'password' : 'publickey',
      description: updated.description,
    }) }],
  };
}

// ---------------------------------------------------------------------------
// Tool 3: warpgate_remove_target
// ---------------------------------------------------------------------------

export const removeTargetTool = {
  name: 'warpgate_remove_target',
  description: '[WRITE] Remove a target from the Warpgate bastion',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target UUID' },
    },
    required: ['id'],
  },
};

export async function handleRemoveTarget(
  warpgateWriteDb: Database,
  args: Record<string, unknown>,
  auditLog: (entry: Record<string, unknown>) => void,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const id = args.id as string;

  // Get target info before deletion (for audit log)
  const target = warpgateWriteDb.prepare('SELECT id, name FROM targets WHERE id = ?').get(id) as Record<string, unknown> | undefined;

  if (!target) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Target not found' }) }],
      isError: true,
    };
  }

  // 用事务包裹删除操作，确保原子性
  const removeResult = warpgateWriteDb.transaction(() => {
    // Delete from target_roles first (FK constraint)
    warpgateWriteDb.prepare('DELETE FROM target_roles WHERE target_id = ?').run(id);

    // Delete from targets
    const info = warpgateWriteDb.prepare('DELETE FROM targets WHERE id = ?').run(id);

    if (info.changes === 0) {
      return { error: 'Target not found' };
    }

    return { success: true };
  })();

  if (removeResult.error) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: removeResult.error }) }],
      isError: true,
    };
  }

  // Audit log
  auditLog({
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    tool: 'warpgate_remove_target',
    target: target.name as string,
    command: '',
    exitCode: null,
    durationMs: 0,
    riskLevel: 'low',
    status: 'success',
    params: { targetId: id },
  });

  return {
    content: [{ type: 'text', text: JSON.stringify({ id, name: target.name, deleted: true }) }],
  };
}

// ---------------------------------------------------------------------------
// Tool 4: warpgate_get_target
// ---------------------------------------------------------------------------

export const getTargetTool = {
  name: 'warpgate_get_target',
  description: '[READONLY] Get details of a specific target by ID or name',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target UUID' },
      name: { type: 'string', description: 'Target name' },
    },
  },
};

export async function handleGetTarget(
  warpgateWriteDb: Database,
  args: Record<string, unknown>,
  _auditLog?: (entry: Record<string, unknown>) => void,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const id = args.id as string | undefined;
  const name = args.name as string | undefined;

  if (!id && !name) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Must provide id or name' }) }],
      isError: true,
    };
  }

  let row: Record<string, unknown> | undefined;

  if (id) {
    row = warpgateWriteDb.prepare('SELECT * FROM targets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  } else {
    row = warpgateWriteDb.prepare('SELECT * FROM targets WHERE name = ?').get(name) as Record<string, unknown> | undefined;
  }

  if (!row) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Target not found' }) }],
      isError: true,
    };
  }

  const options = JSON.parse((row.options as string) || '{}') as Record<string, unknown>;
  const auth = options.auth as Record<string, unknown> | undefined;

  return {
    content: [{ type: 'text', text: JSON.stringify({
      id: row.id,
      name: row.name,
      kind: row.kind,
      host: options.host,
      port: options.port,
      username: options.username,
      auth_kind: auth?.kind === 'Password' ? 'password' : 'publickey',
      description: row.description,
    }) }],
  };
}
