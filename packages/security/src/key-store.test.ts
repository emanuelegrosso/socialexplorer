import { describe, expect, it } from "vitest";
import { KeyringKeyStore, MemoryKeyStore, type KeyringEntry } from "./key-store.js";

describe("MemoryKeyStore", () => {
  it("returns a stable 32-byte key until deleted", async () => {
    const store = new MemoryKeyStore();
    const a = await store.getOrCreate();
    expect(a.byteLength).toBe(32);
    expect((await store.getOrCreate()).equals(a)).toBe(true);
    await store.delete();
    expect((await store.getOrCreate()).equals(a)).toBe(false);
  });

  it("hands out copies so callers cannot mutate the stored key", async () => {
    const store = new MemoryKeyStore();
    const a = await store.getOrCreate();
    a.fill(0);
    expect((await store.getOrCreate()).equals(a)).toBe(false);
  });
});

describe("KeyringKeyStore", () => {
  function fakeEntry(): { entry: KeyringEntry; calls: string[]; value: () => string | null } {
    let password: string | null = null;
    const calls: string[] = [];
    return {
      calls,
      value: () => password,
      entry: {
        getPassword: () => password,
        setPassword: (value) => {
          calls.push("set");
          password = value;
        },
        deletePassword: () => {
          calls.push("delete");
          const had = password !== null;
          password = null;
          return had;
        },
      },
    };
  }

  it("creates once under the SocialExplorer service and reuses the key", async () => {
    const fake = fakeEntry();
    const seen: string[] = [];
    const store = new KeyringKeyStore({
      entryFactory: (service, account) => {
        seen.push(service, account);
        return fake.entry;
      },
    });
    const a = await store.getOrCreate();
    const b = await store.getOrCreate();
    expect(seen).toEqual(["SocialExplorer", "connector-auth-key"]);
    expect(a.equals(b)).toBe(true);
    expect(fake.calls).toEqual(["set"]);
    await store.delete();
    expect(fake.value()).toBeNull();
  });

  it("rejects stored keys of the wrong length", async () => {
    const fake = fakeEntry();
    fake.entry.setPassword(Buffer.alloc(8).toString("base64"));
    const store = new KeyringKeyStore({ entryFactory: () => fake.entry });
    await expect(store.getOrCreate()).rejects.toThrow("secure_storage_key_invalid_length");
  });
});
