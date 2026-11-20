import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";
import { MemoryKeyStore } from "./key-store.js";
import { ProtectedStore } from "./protected-store.js";

describe("ProtectedStore", () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "se-sec-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("encrypts values on disk and round-trips them", async () => {
    const directory = join(tmp(), "connector-auth");
    const store = new ProtectedStore({ directory, keyStore: new MemoryKeyStore() });
    await store.setJson("creds", { noiseKey: "synthetic-private-key", registrationId: 7 });
    await store.set("pre-key:1", Buffer.from([1, 2, 3]));
    const files = readdirSync(directory);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(readFileSync(join(directory, file)).toString("utf8")).not.toContain(
        "synthetic-private-key",
      );
    }
    expect(await store.getJson("creds")).toEqual({
      noiseKey: "synthetic-private-key",
      registrationId: 7,
    });
    expect((await store.get("pre-key:1"))?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(await store.list()).toEqual(["creds", "pre-key:1"]);
    expect(await store.get("missing")).toBeUndefined();
  });

  it("returns undefined when the key no longer matches or the file is corrupt", async () => {
    const directory = tmp();
    const store = new ProtectedStore({ directory, keyStore: new MemoryKeyStore() });
    await store.set("creds", "x");
    const other = new ProtectedStore({ directory, keyStore: new MemoryKeyStore() });
    expect(await other.get("creds")).toBeUndefined();
    const [file] = readdirSync(directory);
    writeFileSync(join(directory, file ?? ""), "garbage");
    expect(await store.get("creds")).toBeUndefined();
  });

  it("rejects unsafe names", async () => {
    const store = new ProtectedStore({ directory: tmp(), keyStore: new MemoryKeyStore() });
    for (const name of ["", "../escape", "a/../b", "/abs", "x\0y"]) {
      await expect(store.set(name, "v")).rejects.toThrow("secure_storage_invalid_name");
    }
  });

  it("clear removes blobs and the data key (explicit logout)", async () => {
    const keyStore = new MemoryKeyStore();
    const directory = tmp();
    const store = new ProtectedStore({ directory, keyStore });
    await store.set("creds", "x");
    const before = await keyStore.getOrCreate();
    await store.clear();
    expect(readdirSync(directory)).toEqual([]);
    expect((await keyStore.getOrCreate()).equals(before)).toBe(false);
    await store.remove("creds");
  });

  it("writes atomically without leaving temp files", () => {
    const dir = tmp();
    const target = join(dir, "file.bin");
    writeFileAtomic(target, Buffer.from("one"));
    writeFileAtomic(target, Buffer.from("two"));
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["file.bin"]);
  });
});
