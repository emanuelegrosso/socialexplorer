import { Entry } from "@napi-rs/keyring";
import { randomBytes } from "node:crypto";
import { KEY_BYTES } from "./crypto.js";

export interface KeyStore {
  getOrCreate(): Promise<Buffer>;
  delete(): Promise<void>;
}

export const KEYRING_SERVICE = "SocialExplorer" as const;
export const KEYRING_ACCOUNT = "connector-auth-key" as const;

/** In-process key for unit tests and CI hosts without an OS keychain. Never persisted. */
export class MemoryKeyStore implements KeyStore {
  private key: Buffer | undefined;

  getOrCreate(): Promise<Buffer> {
    this.key ??= randomBytes(KEY_BYTES);
    return Promise.resolve(Buffer.from(this.key));
  }

  delete(): Promise<void> {
    this.key = undefined;
    return Promise.resolve();
  }
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

const defaultEntryFactory: KeyringEntryFactory = (service, account) => new Entry(service, account);

/** Stores the 256-bit data key in the OS credential store (Windows Credential Manager, Keychain, Secret Service). */
export class KeyringKeyStore implements KeyStore {
  private readonly entry: KeyringEntry;

  constructor(
    options: {
      readonly service?: string;
      readonly account?: string;
      readonly entryFactory?: KeyringEntryFactory;
    } = {},
  ) {
    const factory = options.entryFactory ?? defaultEntryFactory;
    this.entry = factory(options.service ?? KEYRING_SERVICE, options.account ?? KEYRING_ACCOUNT);
  }

  getOrCreate(): Promise<Buffer> {
    const existing = this.entry.getPassword();
    if (existing !== null) {
      const key = Buffer.from(existing, "base64");
      if (key.byteLength !== KEY_BYTES) {
        return Promise.reject(new Error("secure_storage_key_invalid_length"));
      }
      return Promise.resolve(key);
    }
    const key = randomBytes(KEY_BYTES);
    this.entry.setPassword(key.toString("base64"));
    return Promise.resolve(key);
  }

  delete(): Promise<void> {
    this.entry.deletePassword();
    return Promise.resolve();
  }
}
