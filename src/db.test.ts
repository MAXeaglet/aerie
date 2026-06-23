import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openWarpgateDbWritable, getAdminRoleId } from './db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

describe('openWarpgateDbWritable', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'aerie-test-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should open a writable database and perform inserts', () => {
    const dbPath = join(tmpDir, 'test.db');
    // Create the file first since openWarpgateDbWritable uses fileMustExist: true
    const initDb = new Database(dbPath, { readonly: false, fileMustExist: false });
    initDb.close();
    const db = openWarpgateDbWritable(dbPath);
    expect(db).toBeInstanceOf(Database);

    // Can write
    db.exec('CREATE TABLE targets (id TEXT PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO targets (id, name) VALUES (?, ?)').run('abc-123', 'test-server');
    const row = db.prepare('SELECT name FROM targets WHERE id = ?').get('abc-123') as any;
    expect(row.name).toBe('test-server');
    db.close();
  });

  it('should throw on non-existent file when fileMustExist=true', () => {
    expect(() => openWarpgateDbWritable('/nonexistent/path/db.sqlite3')).toThrow();
  });

  it('should set WAL journal mode', () => {
    const dbPath = join(tmpDir, 'wal-test.db');
    // Create the file first since openWarpgateDbWritable uses fileMustExist: true
    const initDb = new Database(dbPath, { readonly: false, fileMustExist: false });
    initDb.close();
    const db = openWarpgateDbWritable(dbPath);
    const mode = db.pragma('journal_mode', { simple: true }) as string;
    expect(mode.toLowerCase()).toBe('wal');
    db.close();
  });
});

describe('getAdminRoleId', () => {
  it('should return the admin role UUID when admin role exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, description TEXT NOT NULL DEFAULT "", is_default INTEGER NOT NULL DEFAULT 0)');
    db.prepare("INSERT INTO roles (id, name) VALUES (?, 'admin')").run('admin-uuid-123');
    const id = getAdminRoleId(db);
    expect(id).toBe('admin-uuid-123');
    db.close();
  });

  it('should return null when admin role does not exist', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT, description TEXT NOT NULL DEFAULT "", is_default INTEGER NOT NULL DEFAULT 0)');
    db.prepare("INSERT INTO roles (id, name) VALUES (?, 'user')").run('user-uuid-456');
    const id = getAdminRoleId(db);
    expect(id).toBeNull();
    db.close();
  });
});
