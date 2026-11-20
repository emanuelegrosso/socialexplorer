import type { PortAuthState } from "@social-explorer/baileys-adapter";
import type { ProtectedStore } from "@social-explorer/security";
import { decodeAuthValue, encodeAuthValue } from "./auth-serialize.js";

const CREDS_NAME = "auth/creds";
const KEY_PREFIX = "auth/key/";

function keyName(type: string, id: string): string {
  if (!/^[A-Za-z0-9-]+$/u.test(type)) {
    throw new Error("auth_invalid_key_type");
  }
  return `${KEY_PREFIX}${type}/${Buffer.from(id, "utf8").toString("hex")}`;
}

/**
 * Baileys auth state persisted ONLY through the encrypted ProtectedStore: never SQLite, never the
 * renderer, never logs. `creds.update` events are merged and persisted incrementally.
 */
export class ProtectedAuthState {
  readonly state: PortAuthState;
  private readonly creds: Record<string, unknown>;
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly store: ProtectedStore,
    creds: Record<string, unknown>,
    readonly restored: boolean,
  ) {
    this.creds = creds;
    this.state = {
      creds: this.creds,
      keys: {
        get: async (type, ids) => {
          const output: Record<string, unknown> = {};
          for (const id of ids) {
            const value = await this.store.getJson<unknown>(keyName(type, id));
            if (value !== undefined) {
              output[id] = decodeAuthValue(value);
            }
          }
          return output;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              tasks.push(
                value === undefined || value === null
                  ? this.store.remove(keyName(type, id))
                  : this.store.setJson(keyName(type, id), encodeAuthValue(value)),
              );
            }
          }
          await Promise.all(tasks);
        },
      },
    };
  }

  static async open(
    store: ProtectedStore,
    createInitialCreds: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<ProtectedAuthState> {
    const stored = await store.getJson<unknown>(CREDS_NAME);
    if (stored !== undefined) {
      return new ProtectedAuthState(store, decodeAuthValue(stored) as Record<string, unknown>, true);
    }
    const created = await createInitialCreds();
    const auth = new ProtectedAuthState(store, created, false);
    await auth.saveCreds();
    return auth;
  }

  /** Merge a (partial) `creds.update` payload and persist the full credentials. Writes are serialized. */
  saveCreds(update?: Readonly<Record<string, unknown>>): Promise<void> {
    if (update !== undefined) {
      Object.assign(this.creds, update);
    }
    const run = async (): Promise<void> => {
      await this.store.setJson(CREDS_NAME, encodeAuthValue(this.creds));
    };
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  /** Own JID (without device suffix) once paired, for self-contact attribution. */
  selfJid(): string | undefined {
    const me = this.creds["me"];
    if (me !== null && typeof me === "object") {
      const id = (me as Record<string, unknown>)["id"];
      return typeof id === "string" ? id : undefined;
    }
    return undefined;
  }

  isRegistered(): boolean {
    return this.selfJid() !== undefined;
  }

  /**
   * Explicit logout / delete: wipes every protected auth blob and the data key. Never touches the
   * SQLite archive, which lives outside the protected directory.
   */
  async clear(): Promise<void> {
    await this.writes.catch(() => undefined);
    await this.store.clear();
  }
}
