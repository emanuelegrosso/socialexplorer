import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_COMMAND_TYPES, parseConnectorEvent, parseHostCommand } from "./protocol.js";

describe("IPC protocol", () => {
  it("exposes a closed command set with no generic execution verbs", () => {
    expect([...HOST_COMMAND_TYPES].sort()).toEqual(
      ["delete-auth", "ingest-ack", "logout", "ping", "request-pairing-code", "shutdown", "start", "stop"].sort(),
    );
    for (const type of HOST_COMMAND_TYPES) {
      expect(type).not.toMatch(/exec|eval|run|shell|spawn|send-?message|invoke/u);
    }
  });

  it("rejects unknown types, extra fields, and malformed payloads", () => {
    expect(parseHostCommand({ type: "exec", cmd: "ls" }).ok).toBe(false);
    expect(parseHostCommand({ type: "ping", nonce: "n", extra: 1 }).ok).toBe(false);
    expect(parseHostCommand({ type: "request-pairing-code", phoneNumber: "not a phone" }).ok).toBe(false);
    expect(parseHostCommand({ type: "start", datasetId: "", timezone: "UTC" }).ok).toBe(false);
    expect(parseHostCommand("ping").ok).toBe(false);
    expect(parseHostCommand(null).ok).toBe(false);
    expect(parseHostCommand({ type: "ping", nonce: "n" }).ok).toBe(true);
    expect(parseHostCommand({ type: "request-pairing-code", phoneNumber: "+1 555 010 0001" }).ok).toBe(true);
  });

  it("rejects unknown connector events", () => {
    expect(parseConnectorEvent({ type: "execute" }).ok).toBe(false);
    expect(parseConnectorEvent({ type: "heartbeat", seq: 1, atMs: 1, extra: true }).ok).toBe(false);
    expect(parseConnectorEvent({ type: "heartbeat", seq: 1, atMs: 1 }).ok).toBe(true);
    expect(parseConnectorEvent({ type: "ready", protocolVersion: 2, pid: 1 }).ok).toBe(false);
  });

  it("source never imports exec/spawn or evaluates code", () => {
    const dir = import.meta.dirname;
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text, name).not.toMatch(/\b(execSync|execFile|spawn|spawnSync)\s*\(/u);
      expect(text, name).not.toMatch(/child_process\.(exec|execFile|spawn)\b/u);
      expect(text, name).not.toMatch(/\beval\s*\(|new Function\s*\(/u);
      expect(text, name).not.toMatch(/sendMessage/u);
    }
  });
});
