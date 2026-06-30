import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const SERVICE_NAME = 'aerie';
const TOKEN_KEY = 'auth-token';

const CONFIG_DIR = join(homedir(), '.warpgate-mcp');
const SECRETS_FILE = join(CONFIG_DIR, 'secrets');

const ALGORITHM = 'aes-256-gcm';
const KEY_ITERATIONS = 200_000;
const KEY_DIGEST = 'sha512';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

export interface SecretStore {
  getToken(): string | null;
  setToken(token: string): void;
  deleteToken(): void;
  hasToken(): boolean;
  backendName(): string;
}

function deriveMachineKey(): Buffer {
  const parts: string[] = [hostname()];

  try {
    const mid = readFileSync('/etc/machine-id', 'utf-8').trim();
    if (mid) parts.push(mid);
  } catch { /* noop */ }

  try {
    const mid = readFileSync('/var/lib/dbus/machine-id', 'utf-8').trim();
    if (mid) parts.push(mid);
  } catch { /* noop */ }

  try {
    const buf = execSync(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid 2>nul',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const m = buf.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
    if (m?.[1]) parts.push(m[1]);
  } catch { /* noop */ }

  try {
    const buf = execSync(
      'ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | grep IOPlatformUUID',
      { encoding: 'utf-8', timeout: 3000 }
    );
    const m = buf.match(/IOPlatformUUID" = "([^"]+)"/);
    if (m?.[1]) parts.push(m[1]);
  } catch { /* noop */ }

  parts.push(homedir());

  const source = parts.join('|');
  const salt = Buffer.from('aerie-file-key-v1');
  return pbkdf2Sync(source, salt, KEY_ITERATIONS, 32, KEY_DIGEST);
}

export class FileSecretStore implements SecretStore {
  private key: Buffer;
  private cache: Map<string, string | null> = new Map();

  constructor() {
    this.key = deriveMachineKey();
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (process.platform !== 'win32') {
      try { chmodSync(CONFIG_DIR, 0o700); } catch { /* noop */ }
    }
  }

  backendName(): string {
    return 'encrypted-file';
  }

  getToken(): string | null {
    return this._get(TOKEN_KEY);
  }

  setToken(token: string): void {
    this._set(TOKEN_KEY, token);
  }

  deleteToken(): void {
    this._delete(TOKEN_KEY);
  }

  hasToken(): boolean {
    return this.getToken() !== null;
  }

  private _get(key: string): string | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    if (!existsSync(SECRETS_FILE)) return null;

    try {
      const raw = readFileSync(SECRETS_FILE);
      const data = this._decrypt(raw);
      const json = JSON.parse(data);
      const val = json[key] ?? null;
      this.cache.set(key, val);
      return val;
    } catch {
      return null;
    }
  }

  private _set(key: string, value: string): void {
    const existing: Record<string, string> = {};
    if (existsSync(SECRETS_FILE)) {
      try {
        const raw = readFileSync(SECRETS_FILE);
        const data = this._decrypt(raw);
        Object.assign(existing, JSON.parse(data));
      } catch { /* noop */ }
    }

    existing[key] = value;
    const plain = JSON.stringify(existing);
    const encrypted = this._encrypt(plain);
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(SECRETS_FILE, encrypted);
    if (process.platform !== 'win32') {
      try { chmodSync(SECRETS_FILE, 0o600); } catch { /* noop */ }
    }
    this.cache.set(key, value);
  }

  private _delete(key: string): void {
    const existing: Record<string, string> = {};
    if (existsSync(SECRETS_FILE)) {
      try {
        const raw = readFileSync(SECRETS_FILE);
        const data = this._decrypt(raw);
        Object.assign(existing, JSON.parse(data));
      } catch { /* noop */ }
    }

    delete existing[key];
    if (Object.keys(existing).length === 0) {
      try { unlinkSync(SECRETS_FILE); } catch { /* noop */ }
    } else {
      const plain = JSON.stringify(existing);
      const encrypted = this._encrypt(plain);
      writeFileSync(SECRETS_FILE, encrypted);
      if (process.platform !== 'win32') {
        try { chmodSync(SECRETS_FILE, 0o600); } catch { /* noop */ }
      }
    }
    this.cache.set(key, null);
  }

  private _encrypt(plaintext: string): Buffer {
    const salt = randomBytes(SALT_LENGTH);
    const key = pbkdf2Sync(this.key, salt, KEY_ITERATIONS, 32, KEY_DIGEST);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([salt, iv, tag, encrypted]);
  }

  private _decrypt(data: Buffer): string {
    if (data.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
      throw new Error('Secrets file too short');
    }
    let offset = 0;
    const salt = data.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
    const iv = data.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
    const tag = data.subarray(offset, offset + TAG_LENGTH); offset += TAG_LENGTH;
    const encrypted = data.subarray(offset);

    const key = pbkdf2Sync(this.key, salt, KEY_ITERATIONS, 32, KEY_DIGEST);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf-8');
  }
}

let KeyringEntryType: any = null;
let keyringAvailable = false;

try {
  const req = createRequire(import.meta.url);
  const keyring = req('@napi-rs/keyring');
  KeyringEntryType = keyring.Entry;
  keyringAvailable = true;
} catch {
  keyringAvailable = false;
}

export class KeyringStore implements SecretStore {
  backendName(): string {
    return keyringAvailable ? 'os-keyring' : 'os-keyring(unavailable)';
  }

  hasToken(): boolean {
    return this.getToken() !== null;
  }

  getToken(): string | null {
    if (!keyringAvailable) return null;
    try {
      const entry = new KeyringEntryType(SERVICE_NAME, TOKEN_KEY);
      const val = entry.getPassword();
      return val ?? null;
    } catch {
      return null;
    }
  }

  setToken(token: string): void {
    if (!keyringAvailable) {
      throw new Error('OS keyring not available on this platform');
    }
    const entry = new KeyringEntryType(SERVICE_NAME, TOKEN_KEY);
    entry.setPassword(token);
  }

  deleteToken(): void {
    if (!keyringAvailable) return;
    try {
      const entry = new KeyringEntryType(SERVICE_NAME, TOKEN_KEY);
      entry.deletePassword();
    } catch { /* noop */ }
  }
}

export class AutoSecretStore implements SecretStore {
  private fileStore: FileSecretStore;
  private keyringStore: KeyringStore;

  constructor() {
    this.fileStore = new FileSecretStore();
    this.keyringStore = new KeyringStore();
  }

  backendName(): string {
    if (keyringAvailable && this.keyringStore.hasToken()) return 'os-keyring';
    return this.fileStore.backendName();
  }

  getToken(): string | null {
    if (keyringAvailable) {
      try {
        const t = this.keyringStore.getToken();
        if (t !== null) return t;
      } catch { /* fallthrough */ }
    }
    return this.fileStore.getToken();
  }

  setToken(token: string): void {
    if (keyringAvailable) {
      this.keyringStore.setToken(token);
      this.fileStore.deleteToken();
    } else {
      this.fileStore.setToken(token);
    }
  }

  deleteToken(): void {
    this.keyringStore.deleteToken();
    this.fileStore.deleteToken();
  }

  hasToken(): boolean {
    return this.getToken() !== null;
  }
}

let _instance: AutoSecretStore | null = null;

export function getSecretStore(): AutoSecretStore {
  if (!_instance) {
    _instance = new AutoSecretStore();
  }
  return _instance;
}
