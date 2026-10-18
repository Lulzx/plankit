import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** One ChatGPT account registration on this host, keyed by its issued client ID. */
export interface AccountRecord {
  clientId: string;
  issuer: string;
  subject: string;
  email?: string;
  name?: string;
  /** Retained for `id_token_hint`; cleared on sign-out. */
  idToken?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  /** Epoch ms before which the server asks us not to refresh. */
  earliestRefreshAt?: number;
  scopes: string[];
  savedAt: string;
}

export interface StoreData {
  version: 1;
  hostId: string;
  activeClientId?: string;
  accounts: Record<string, AccountRecord>;
}

/** Where credentials live. Swap in a keychain-backed store by implementing this interface. */
export interface CredentialStore {
  read(): Promise<StoreData | null>;
  write(data: StoreData): Promise<void>;
  /** Run `fn` while holding an exclusive lock, so refreshes don't race across processes. */
  lock<T>(fn: () => Promise<T>): Promise<T>;
}

export function defaultConfigDir(appId: string): string {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, appId);
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, appId);
}

export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

/** JSON file store: atomic writes, owner-only permissions, mkdir-based cross-process lock. */
export class FileStore implements CredentialStore {
  readonly file: string;
  private readonly lockDir: string;

  constructor(readonly dir: string) {
    this.file = join(dir, "credentials.json");
    this.lockDir = join(dir, "credentials.lock");
  }

  async read(): Promise<StoreData | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as StoreData;
    } catch (e: any) {
      if (e?.code === "ENOENT") return null;
      throw e;
    }
  }

  async write(data: StoreData): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async lock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        await mkdir(this.lockDir);
        break;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
        // Break locks left behind by a crashed process.
        const age = await stat(this.lockDir).then((s) => Date.now() - s.mtimeMs, () => 0);
        if (age > 60_000) await rm(this.lockDir, { recursive: true, force: true });
        else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${this.lockDir}`);
        else await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
      }
    }
    try {
      return await fn();
    } finally {
      await rm(this.lockDir, { recursive: true, force: true });
    }
  }
}

/** In-memory store, useful for tests or apps that persist credentials themselves. */
export class MemoryStore implements CredentialStore {
  private data: StoreData | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  async read() {
    return this.data ? structuredClone(this.data) : null;
  }

  async write(data: StoreData) {
    this.data = structuredClone(data);
  }

  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}
