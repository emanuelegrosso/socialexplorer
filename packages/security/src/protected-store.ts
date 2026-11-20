import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { removeFileIfExists, writeFileAtomic } from "./atomic-write.js";
import { decryptPayload, encryptPayload } from "./crypto.js";
import type { KeyStore } from "./key-store.js";

const EXTENSION = ".enc";
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/u;

export interface ProtectedStoreOptions {
  /** Directory dedicated to protected connector auth data; must live outside the SQLite folder. */
  readonly directory: string;
  readonly keyStore: KeyStore;
}

/**
 * Encrypted, atomically-written blob store for connector auth material. It is intentionally
 * independent of SQLite: deleting the database never touches it and vice versa.
 * Callers (the connector adapter) own the schema of the stored values.
 */
export class ProtectedStore {
  private readonly directory: string;
  private readonly keyStore: KeyStore;

  constructor(options: ProtectedStoreOptions) {
    this.directory = options.directory;
    this.keyStore = options.keyStore;
  }

  async set(name: string, value: Buffer | string): Promise<void> {
    const file = this.fileFor(name);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const key = await this.keyStore.getOrCreate();
    const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    writeFileAtomic(file, encryptPayload(key, data));
  }

  /** Returns undefined when absent, or when the payload cannot be authenticated with the current key. */
  async get(name: string): Promise<Buffer | undefined> {
    const payload = await readFile(this.fileFor(name)).catch(() => null);
    if (payload === null) {
      return undefined;
    }
    const key = await this.keyStore.getOrCreate();
    try {
      return decryptPayload(key, payload);
    } catch {
      return undefined;
    }
  }

  async setJson(name: string, value: unknown): Promise<void> {
    await this.set(name, JSON.stringify(value));
  }

  async getJson<T>(name: string): Promise<T | undefined> {
    const data = await this.get(name);
    return data === undefined ? undefined : (JSON.parse(data.toString("utf8")) as T);
  }

  remove(name: string): Promise<void> {
    removeFileIfExists(this.fileFor(name));
    return Promise.resolve();
  }

  async list(): Promise<string[]> {
    const entries = await readdir(this.directory).catch(() => []);
    return entries
      .filter((entry) => entry.endsWith(EXTENSION))
      .map((entry) => Buffer.from(entry.slice(0, -EXTENSION.length), "base64url").toString("utf8"))
      .sort();
  }

  /** Explicit logout / auth deletion: removes every blob and the data key. */
  async clear(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => []);
    for (const entry of entries) {
      if (entry.endsWith(EXTENSION) || entry.endsWith(".tmp")) {
        removeFileIfExists(join(this.directory, entry));
      }
    }
    await this.keyStore.delete();
  }

  private fileFor(name: string): string {
    if (!NAME_PATTERN.test(name) || name.includes("..")) {
      throw new Error("secure_storage_invalid_name");
    }
    return join(this.directory, `${Buffer.from(name, "utf8").toString("base64url")}${EXTENSION}`);
  }
}
