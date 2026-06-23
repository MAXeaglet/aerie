import Database from 'better-sqlite3';
import type { TargetInfo } from './types.js';
import { TargetInfoSchema } from './types.js';

type WarpgateDb = InstanceType<typeof Database>;

export interface DbRoleInfo {
  id: string;
  name: string;
  targetId?: string;
}

const EXPECTED_TABLES = ['targets', 'roles', 'target_roles'];

function parseOptions(optionsJson: string | null | undefined): { host: string; port: number; username: string } {
  try {
    const opts = JSON.parse(optionsJson || '{}');
    return {
      host: typeof opts.host === 'string' ? opts.host : '',
      port: typeof opts.port === 'number' ? opts.port : 22,
      username: typeof opts.username === 'string' ? opts.username : 'root',
    };
  } catch {
    return { host: '', port: 22, username: 'root' };
  }
}

/**
 * Open a read-only Warpgate SQLite database connection.
 */
export function openWarpgateDb(dbPath: string): WarpgateDb {
  let     db: WarpgateDb;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw new Error(`Warpgate database not found at ${dbPath}`);
  }
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Open a WRITABLE Warpgate SQLite database connection.
 * Used for CREATE / UPDATE / DELETE operations on targets table.
 */
export function openWarpgateDbWritable(dbPath: string): WarpgateDb {
  let db: WarpgateDb;
  try {
    db = new Database(dbPath, { readonly: false, fileMustExist: true });
  } catch (err) {
    throw new Error(`Cannot open Warpgate database at ${dbPath} for writing`);
  }
  // Must set WAL mode to match the read-only connection
  // Without WAL, the write connection might use DELETE journal mode and block readers
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Get the UUID of the admin role.
 * Returns null if admin role doesn't exist.
 */
export function getAdminRoleId(db: WarpgateDb): string | null {
  const row = db.prepare("SELECT id FROM roles WHERE name = 'admin'").get() as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Read the targets table and return a complete list.
 */
export function listTargets(    db: WarpgateDb): TargetInfo[] {
  const rows = db.prepare(
    'SELECT id, name, kind, options, description FROM targets'
  ).all() as Array<{
    id: string;
    name: string;
    kind: string;
    options: string | null;
    description: string | null;
  }>;

  return rows.map(row => {
    const { host, port, username } = parseOptions(row.options);
    return TargetInfoSchema.parse({
      id: row.id,
      name: row.name,
      kind: row.kind,
      host,
      port,
      username,
      description: row.description || '',
    });
  });
}

/**
 * Find a target by its name. Returns null if not found.
 */
export function getTargetByName(    db: WarpgateDb, name: string): TargetInfo | null {
  const row = db.prepare(
    'SELECT id, name, kind, options, description FROM targets WHERE name = ?'
  ).get(name) as {
    id: string;
    name: string;
    kind: string;
    options: string | null;
    description: string | null;
  } | undefined;

  if (!row) return null;

  const { host, port, username } = parseOptions(row.options);
  return TargetInfoSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    host,
    port,
    username,
    description: row.description || '',
  });
}

/**
 * Validate that the database has all expected tables.
 * Returns a list of missing table names (empty if all present).
 */
export function validateSchema(    db: WarpgateDb): string[] {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as Array<{ name: string }>;

  const existing = new Set(tables.map(t => t.name));
  return EXPECTED_TABLES.filter(t => !existing.has(t));
}

/**
 * List all roles with optional target association.
 */
export function listRoles(    db: WarpgateDb): DbRoleInfo[] {
  const rows = db.prepare(`
    SELECT r.id, r.name, tr.target_id AS targetId
    FROM roles r
    LEFT JOIN target_roles tr ON tr.role_id = r.id
  `).all() as Array<{
    id: string;
    name: string;
    targetId: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    name: r.name,
    targetId: r.targetId || undefined,
  }));
}
