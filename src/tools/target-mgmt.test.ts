import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  addTargetTool,
  handleAddTarget,
  editTargetTool,
  handleEditTarget,
  removeTargetTool,
  handleRemoveTarget,
  getTargetTool,
  handleGetTarget,
} from './target-mgmt.js';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS targets (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      options TEXT NOT NULL,
      rate_limit_bytes_per_second INTEGER,
      group_id TEXT,
      ticket_max_duration_seconds INTEGER,
      ticket_requests_disabled INTEGER NOT NULL DEFAULT 0,
      ticket_require_approval INTEGER NOT NULL DEFAULT 0,
      ticket_max_uses INTEGER
    );

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS target_roles (
      id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      target_id TEXT NOT NULL,
      role_id TEXT NOT NULL
    );
  `);
  return db;
}

function noopAuditLog(_entry: Record<string, unknown>): void {
  // no-op
}

const defaultTargetArgs = {
  name: 'test-server',
  host: '192.168.1.100',
};

const adminRoleId = 'admin-role-001';

// --------------------------------------------------------------------------
// Tool definition shape tests
// --------------------------------------------------------------------------

describe('addTargetTool definition', () => {
  it('should have the correct name and description', () => {
    expect(addTargetTool.name).toBe('warpgate_add_target');
    expect(addTargetTool.description).toContain('[WRITE]');
  });

  it('should require name and host', () => {
    expect(addTargetTool.inputSchema.required).toContain('name');
    expect(addTargetTool.inputSchema.required).toContain('host');
  });
});

describe('editTargetTool definition', () => {
  it('should have the correct name', () => {
    expect(editTargetTool.name).toBe('warpgate_edit_target');
  });

  it('should require id', () => {
    expect(editTargetTool.inputSchema.required).toContain('id');
  });
});

describe('removeTargetTool definition', () => {
  it('should have the correct name', () => {
    expect(removeTargetTool.name).toBe('warpgate_remove_target');
  });

  it('should require id', () => {
    expect(removeTargetTool.inputSchema.required).toContain('id');
  });
});

describe('getTargetTool definition', () => {
  it('should have the correct name', () => {
    expect(getTargetTool.name).toBe('warpgate_get_target');
  });

  it('should not require any field (id or name are optional)', () => {
    expect('required' in getTargetTool.inputSchema).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Handler tests
// --------------------------------------------------------------------------

describe('handleAddTarget', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Insert admin role so getAdminRoleId() finds it
    db.prepare("INSERT INTO roles (id, name, description, is_default) VALUES (?, 'admin', '', 0)").run(adminRoleId);
  });

  afterEach(() => {
    db.close();
  });

  it('should add a new target', async () => {
    const result = await handleAddTarget(db, defaultTargetArgs, noopAuditLog);

    expect(result.isError).toBeUndefined();

    const body = JSON.parse(result.content[0].text);
    expect(body.name).toBe('test-server');
    expect(body.host).toBe('192.168.1.100');
    expect(body.port).toBe(22);
    expect(body.username).toBe('root');
    expect(body.auth_kind).toBe('publickey');

    // Verify it was actually inserted
    const row = db.prepare('SELECT * FROM targets WHERE id = ?').get(body.id) as any;
    expect(row).toBeTruthy();
    expect(row.name).toBe('test-server');

    // Verify target_roles was created
    const tr = db.prepare('SELECT * FROM target_roles WHERE target_id = ?').get(body.id);
    expect(tr).toBeTruthy();
  });

  it('should reject duplicate target name', async () => {
    await handleAddTarget(db, defaultTargetArgs, noopAuditLog);
    const result = await handleAddTarget(db, defaultTargetArgs, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Target name already exists');
  });

  it('should reject auth_kind=password without auth_password', async () => {
    const result = await handleAddTarget(db, { ...defaultTargetArgs, auth_kind: 'password' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('auth_password');
  });

  it('should accept auth_kind=password with auth_password', async () => {
    const result = await handleAddTarget(
      db,
      { ...defaultTargetArgs, auth_kind: 'password', auth_password: 's3cret' },
      noopAuditLog,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.auth_kind).toBe('password');

    // Verify options JSON contains password
    const row = db.prepare('SELECT options FROM targets WHERE id = ?').get(body.id) as any;
    const options = JSON.parse(row.options);
    expect(options.auth.kind).toBe('Password');
    expect(options.auth.password).toBe('s3cret');
  });

  it('should use custom port and username when provided', async () => {
    const result = await handleAddTarget(
      db,
      { name: 'custom', host: '10.0.0.1', port: 2222, username: 'deploy' },
      noopAuditLog,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.port).toBe(2222);
    expect(body.username).toBe('deploy');
  });

  it('should assign admin role when admin role exists', async () => {
    const result = await handleAddTarget(db, defaultTargetArgs, noopAuditLog);
    const body = JSON.parse(result.content[0].text);

    const tr = db.prepare('SELECT role_id FROM target_roles WHERE target_id = ?').get(body.id) as any;
    expect(tr.role_id).toBe(adminRoleId);
  });

  it('should handle concurrent add with same name (TOCTOU proof)', async () => {
    // Run two concurrent add operations with the same name
    const [result1, result2] = await Promise.all([
      handleAddTarget(db, defaultTargetArgs, noopAuditLog),
      handleAddTarget(db, defaultTargetArgs, noopAuditLog),
    ]);

    // At least one should succeed and one should fail
    const successes = [result1, result2].filter(r => !r.isError);
    const failures = [result1, result2].filter(r => r.isError);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
  });

  it('should reject invalid host format', async () => {
    const result = await handleAddTarget(
      db,
      { name: 'bad-host', host: 'not a valid host!!!' },
      noopAuditLog,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('Invalid host');
  });

  it('should reject empty host', async () => {
    const result = await handleAddTarget(
      db,
      { name: 'empty-host', host: '' },
      noopAuditLog,
    );
    expect(result.isError).toBe(true);
  });

  it('should accept valid domain host', async () => {
    const result = await handleAddTarget(
      db,
      { name: 'valid-domain', host: 'server.example.com' },
      noopAuditLog,
    );
    expect(result.isError).toBeUndefined();
  });

  it('should accept localhost', async () => {
    const result = await handleAddTarget(
      db,
      { name: 'local', host: 'localhost' },
      noopAuditLog,
    );
    expect(result.isError).toBeUndefined();
  });
});

describe('handleGetTarget', () => {
  let db: Database.Database;
  let targetId: string;

  beforeEach(async () => {
    db = createTestDb();
    // Admin role for the add handler
    db.prepare("INSERT INTO roles (id, name, description, is_default) VALUES (?, 'admin', '', 0)").run(adminRoleId);

    const result = await handleAddTarget(
      db,
      { name: 'get-test', host: '10.0.0.55', port: 2222, username: 'admin', description: 'test box' },
      noopAuditLog,
    );
    targetId = JSON.parse(result.content[0].text).id;
  });

  afterEach(() => {
    db.close();
  });

  it('should get target by id', async () => {
    const result = await handleGetTarget(db, { id: targetId }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.id).toBe(targetId);
    expect(body.name).toBe('get-test');
    expect(body.host).toBe('10.0.0.55');
    expect(body.port).toBe(2222);
    expect(body.username).toBe('admin');
    expect(body.description).toBe('test box');
  });

  it('should get target by name', async () => {
    const result = await handleGetTarget(db, { name: 'get-test' }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.name).toBe('get-test');
    expect(body.host).toBe('10.0.0.55');
  });

  it('should return error when target not found', async () => {
    const result = await handleGetTarget(db, { id: 'nonexistent-uuid' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Target not found');
  });

  it('should return error when neither id nor name provided', async () => {
    const result = await handleGetTarget(db, {}, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Must provide id or name');
  });
});

describe('handleEditTarget', () => {
  let db: Database.Database;
  let targetId: string;

  beforeEach(async () => {
    db = createTestDb();
    db.prepare("INSERT INTO roles (id, name, description, is_default) VALUES (?, 'admin', '', 0)").run(adminRoleId);

    const result = await handleAddTarget(
      db,
      { name: 'edit-me', host: '10.0.0.1', port: 22, username: 'root', description: 'original' },
      noopAuditLog,
    );
    targetId = JSON.parse(result.content[0].text).id;
  });

  afterEach(() => {
    db.close();
  });

  it('should update host', async () => {
    const result = await handleEditTarget(db, { id: targetId, host: '10.0.0.99' }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.host).toBe('10.0.0.99');
    expect(body.name).toBe('edit-me'); // unchanged
    expect(body.port).toBe(22); // unchanged
  });

  it('should update multiple fields at once', async () => {
    const result = await handleEditTarget(
      db,
      { id: targetId, host: '172.16.0.1', port: 2222, username: 'deploy', description: 'updated' },
      noopAuditLog,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.host).toBe('172.16.0.1');
    expect(body.port).toBe(2222);
    expect(body.username).toBe('deploy');
    expect(body.description).toBe('updated');
  });

  it('should reject name change to an existing name', async () => {
    // Add second target
    await handleAddTarget(db, { name: 'other-server', host: '10.0.0.2' }, noopAuditLog);

    const result = await handleEditTarget(db, { id: targetId, name: 'other-server' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Target name already exists');
  });

  it('should reject auth_kind=password without auth_password', async () => {
    const result = await handleEditTarget(db, { id: targetId, auth_kind: 'password' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('auth_password');
  });

  it('should change auth to password when valid', async () => {
    const result = await handleEditTarget(
      db,
      { id: targetId, auth_kind: 'password', auth_password: 'newpass' },
      noopAuditLog,
    );

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.auth_kind).toBe('password');

    const row = db.prepare('SELECT options FROM targets WHERE id = ?').get(targetId) as any;
    const opts = JSON.parse(row.options);
    expect(opts.auth.kind).toBe('Password');
    expect(opts.auth.password).toBe('newpass');
  });

  it('should change auth back to publickey and clear password', async () => {
    // First set to password
    await handleEditTarget(db, { id: targetId, auth_kind: 'password', auth_password: 'temp' }, noopAuditLog);
    // Then back to publickey
    const result = await handleEditTarget(db, { id: targetId, auth_kind: 'publickey' }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.auth_kind).toBe('publickey');

    const row = db.prepare('SELECT options FROM targets WHERE id = ?').get(targetId) as any;
    const opts = JSON.parse(row.options);
    expect(opts.auth.kind).toBe('PublicKey');
    expect(opts.auth.password).toBeUndefined();
  });

  it('should return error when target does not exist', async () => {
    const result = await handleEditTarget(db, { id: 'nonexistent' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Target not found');
  });

  it('should keep existing options when auth fields not provided', async () => {
    await handleEditTarget(db, { id: targetId, auth_kind: 'password', auth_password: 'sekret' }, noopAuditLog);

    // Now edit only host without touching auth
    const result = await handleEditTarget(db, { id: targetId, host: '10.0.0.200' }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const row = db.prepare('SELECT options FROM targets WHERE id = ?').get(targetId) as any;
    const opts = JSON.parse(row.options);
    expect(opts.auth.kind).toBe('Password');
    expect(opts.auth.password).toBe('sekret');
    expect(opts.host).toBe('10.0.0.200');
  });

  it('should reject invalid host when editing', async () => {
    const result = await handleEditTarget(
      db,
      { id: targetId, host: '!!!invalid!!!' },
      noopAuditLog,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('Invalid host');
  });
});

describe('handleRemoveTarget', () => {
  let db: Database.Database;
  let targetId: string;

  beforeEach(async () => {
    db = createTestDb();
    db.prepare("INSERT INTO roles (id, name, description, is_default) VALUES (?, 'admin', '', 0)").run(adminRoleId);

    const result = await handleAddTarget(
      db,
      { name: 'remove-me', host: '10.0.0.1' },
      noopAuditLog,
    );
    targetId = JSON.parse(result.content[0].text).id;
  });

  afterEach(() => {
    db.close();
  });

  it('should remove target and clean up target_roles', async () => {
    // Verify target_roles exists before deletion
    const trBefore = db.prepare('SELECT * FROM target_roles WHERE target_id = ?').get(targetId);
    expect(trBefore).toBeTruthy();

    const result = await handleRemoveTarget(db, { id: targetId }, noopAuditLog);

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content[0].text);
    expect(body.deleted).toBe(true);
    expect(body.name).toBe('remove-me');

    // Verify target is gone
    const target = db.prepare('SELECT * FROM targets WHERE id = ?').get(targetId);
    expect(target).toBeUndefined();

    // Verify target_roles is cleaned up
    const trAfter = db.prepare('SELECT * FROM target_roles WHERE target_id = ?').get(targetId);
    expect(trAfter).toBeUndefined();
  });

  it('should return error when target not found', async () => {
    const result = await handleRemoveTarget(db, { id: 'nonexistent' }, noopAuditLog);

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('Target not found');
  });
});
