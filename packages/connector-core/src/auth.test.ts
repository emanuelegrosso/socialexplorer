import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogger, redactLogValue, type LogSink } from "@social-explorer/security";
import { decodeAuthValue, encodeAuthValue } from "./auth-serialize.js";
import { ProtectedAuthState } from "./protected-auth-state.js";
import { harness, newAuthStore, settle } from "./test-helpers.js";
import { connectorStateSchema } from "./protocol.js";

const SECRET = "SYNTHETIC-PRIVATE-KEY-MATERIAL-0123456789";

function allFileBytes(directory: string): string {
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name)).toString("latin1"))
    .join("\n");
}

describe("serialization", () => {
  it("round-trips binary values", () => {
    const value = { a: Buffer.from("hello"), nested: [Buffer.from([1, 2, 3])], n: 5, s: "x" };
    const decoded = decodeAuthValue(JSON.parse(JSON.stringify(encodeAuthValue(value)))) as typeof value;
    expect(Buffer.isBuffer(decoded.a)).toBe(true);
    expect(decoded.a.toString()).toBe("hello");
    expect([...decoded.nested[0]!]).toEqual([1, 2, 3]);
    expect(decoded.n).toBe(5);
  });

  it("revives legacy BufferJSON number arrays", () => {
    const decoded = decodeAuthValue({ type: "Buffer", data: [104, 105] }) as Buffer;
    expect(decoded.toString()).toBe("hi");
  });
});

describe("ProtectedAuthState", () => {
  it("encrypts creds and keys at rest and restores them", async () => {
    const { store, directory } = newAuthStore();
    const auth = await ProtectedAuthState.open(store, () => ({ privateKey: Buffer.from(SECRET) }));
    expect(auth.restored).toBe(false);
    await auth.state.keys.set({ "pre-key": { "1": { public: Buffer.from("pub"), private: Buffer.from(SECRET) }, "2": undefined } });
    await auth.saveCreds({ me: { id: "15551000009:2@s.whatsapp.net" }, registrationId: 7 });
    const bytes = allFileBytes(directory);
    expect(bytes).not.toContain(SECRET);
    expect(bytes).not.toContain("15551000009");
    const reopened = await ProtectedAuthState.open(store, () => ({}));
    expect(reopened.restored).toBe(true);
    expect(reopened.isRegistered()).toBe(true);
    expect((reopened.state.creds["privateKey"] as Buffer).toString()).toBe(SECRET);
    const keys = await reopened.state.keys.get("pre-key", ["1", "2"]);
    expect(Object.keys(keys)).toEqual(["1"]);
    expect(((keys["1"] as { private: Buffer }).private).toString()).toBe(SECRET);
  });

  it("persists creds.update incrementally and serializes concurrent writes", async () => {
    const { store } = newAuthStore();
    const auth = await ProtectedAuthState.open(store, () => ({ counter: 0 }));
    await Promise.all([1, 2, 3, 4, 5].map((n) => auth.saveCreds({ counter: n })));
    const reopened = await ProtectedAuthState.open(store, () => ({}));
    expect(reopened.state.creds["counter"]).toBe(5);
  });

  it("clear wipes auth blobs and the data key but leaves the archive database untouched", async () => {
    const { store, directory } = newAuthStore();
    const archiveDir = join(directory, "..", `archive-${Date.now()}`);
    mkdirSync(archiveDir, { recursive: true });
    const archive = join(archiveDir, "socialexplorer.db");
    writeFileSync(archive, "synthetic archive bytes");
    try {
      const auth = await ProtectedAuthState.open(store, () => ({ k: 1 }));
      await auth.state.keys.set({ session: { a: { x: 1 } } });
      expect((await store.list()).length).toBe(2);
      await auth.clear();
      expect(await store.list()).toEqual([]);
      expect(readdirSync(directory).filter((name) => name.endsWith(".enc"))).toEqual([]);
      expect(readFileSync(archive, "utf8")).toBe("synthetic archive bytes");
      const fresh = await ProtectedAuthState.open(store, () => ({ k: 2 }));
      expect(fresh.restored).toBe(false);
    } finally {
      rmSync(archiveDir, { recursive: true, force: true });
      expect(existsSync(directory)).toBe(true);
    }
  });
});

describe("secret redaction", () => {
  it("engine state, errors and logs never carry creds, keys, QR payloads or pairing codes", async () => {
    const h = harness();
    await h.engine.start();
    const port = h.ports[0]!;
    port.emit({ name: "creds.update", data: { me: { id: "15551000009:2@s.whatsapp.net" }, privateKey: SECRET } });
    port.emit({ name: "connection.update", data: { qr: "2@SYNTHQRPAYLOADAAAAAAAAAAAAAAAA,BBBBBBBBBBBBBBBB,CCCCCCCCCCCCCCCC" } });
    await h.engine.requestPairingCode("+1 555 010 0001");
    await settle(h.engine);

    const states = h.outputs.filter((o) => o.type === "state");
    expect(states.length).toBeGreaterThan(0);
    for (const output of states) {
      const json = JSON.stringify(output);
      expect(json).not.toContain(SECRET);
      expect(json).not.toContain("SYNTHQRPAYLOAD");
      expect(json).not.toContain("15551000009");
      expect(connectorStateSchema.safeParse(output.state).success).toBe(true);
    }
    expect(JSON.stringify(h.outputs.filter((o) => o.type === "error"))).not.toContain(SECRET);

    const lines: string[] = [];
    const sink: LogSink = { write: (line) => lines.push(line), close: () => Promise.resolve() };
    const logger = createLogger({ sink });
    for (const output of h.outputs.filter((entry) => entry.type === "state")) {
      logger.info("connector.output", output);
    }
    expect(JSON.stringify(h.outputs.filter((entry) => entry.type === "pairing-code"))).not.toContain(SECRET);
    logger.info("pairing", {
      pairingCode: "ABCD1234",
      text: "pairing code: ABCD-1234 qr 2@SYNTHQRPAYLOADAAAAAAAAAAAAAAAA,BBBBBBBBBBBBBBBB,CCCCCCCCCCCCCCCC",
    });
    const logged = lines.join("\n");
    expect(logged).not.toContain("SYNTHQRPAYLOAD");
    expect(logged).not.toContain("ABCD1234");
    expect(logged).not.toContain("ABCD-1234");
    expect(logged).not.toContain(SECRET);
    expect(redactLogValue({ creds: { privateKey: SECRET }, keys: [SECRET] })).toEqual({
      creds: "[redacted]",
      keys: "[redacted]",
    });
  });

  it("auth material is only ever written under the protected directory as ciphertext", async () => {
    const h = harness();
    await h.engine.start();
    h.ports[0]!.emit({ name: "creds.update", data: { privateKey: SECRET } });
    await settle(h.engine);
    for (const name of readdirSync(h.directory)) {
      expect(name.endsWith(".enc")).toBe(true);
    }
    expect(allFileBytes(h.directory)).not.toContain(SECRET);
  });
});
