import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileLogSink, createLogger, createMemoryLogSink, parseLogLevel } from "./logger.js";
import { isSensitiveLogKey, redactLogValue, redactText } from "./redact.js";

describe("redaction", () => {
  it("masks QR payloads, pairing codes, bearer tokens, JIDs and phone numbers in text", () => {
    const qr =
      "2@Zm9vYmFyYmF6cXV4MTIzNDU2,YWJjZGVmZ2hpamtsbW5vcA==,cXdlcnR5dWlvcGFzZGY=,bXlzeW50aGV0aWM=";
    const text = [
      `scan ${qr}`,
      "pairing code: ABCD-1234",
      "Authorization Bearer abc.def.ghi",
      "from 393331234567:12@s.whatsapp.net and group 1203630@g.us",
      "call +39 333 123 4567 now",
      "token=sekrit123",
    ].join(" | ");
    const output = redactText(text);
    for (const leaked of [
      "Zm9vYmFy",
      "ABCD-1234",
      "abc.def.ghi",
      "393331234567",
      "1203630",
      "333 123 4567",
      "sekrit123",
    ]) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain("[redacted-qr]");
    expect(output).toContain("[redacted-pairing-code]");
  });

  it("masks sensitive keys recursively but keeps harmless diagnostics", () => {
    const output = redactLogValue({
      level: "ok",
      valid: true,
      count: 3,
      qr: "payload",
      pairingCode: "ABCD1234",
      credentials: { a: 1 },
      apiKey: "k",
      encryptionKey: "k",
      remoteJid: "1@s.whatsapp.net",
      phoneNumber: "+391234567890",
      body: "hello there",
      nested: [{ text: "secret message", id: 4 }],
      buffer: Buffer.from("raw"),
      error: new Error("failed for 1@s.whatsapp.net"),
    }) as Record<string, unknown>;
    expect(output).toMatchObject({
      level: "ok",
      valid: true,
      count: 3,
      qr: "[redacted]",
      body: "[redacted]",
    });
    expect(JSON.stringify(output)).not.toMatch(
      /hello there|secret message|ABCD1234|1@s\.whatsapp|391234567890|"raw"/u,
    );
    expect(output["nested"]).toEqual([{ text: "[redacted]", id: 4 }]);
    expect(isSensitiveLogKey("context")).toBe(false);
    expect(isSensitiveLogKey("valid")).toBe(false);
    expect(isSensitiveLogKey("session_key")).toBe(true);
  });
});

describe("logger", () => {
  it("writes structured redacted JSON lines respecting level", () => {
    const sink = createMemoryLogSink();
    const logger = createLogger({
      sink,
      level: "info",
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    logger.debug("dropped");
    logger.info("connected 393331234567@s.whatsapp.net", {
      qr: "payload",
      messageBody: "x",
      body: "hello",
      attempt: 2,
    });
    logger.error("boom", { error: new Error("bad token=abc") });
    expect(sink.lines).toHaveLength(2);
    const first = JSON.parse(sink.lines[0] ?? "{}") as Record<string, unknown>;
    expect(first).toEqual({
      ts: "2026-01-01T00:00:00.000Z",
      level: "info",
      message: "connected [redacted-jid]",
      meta: { qr: "[redacted]", messageBody: "x", body: "[redacted]", attempt: 2 },
    });
    expect(sink.lines.join("\n")).not.toMatch(/hello|payload|token=abc/u);
  });

  it("persists to a log file and parses levels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "se-log-"));
    try {
      const logger = createLogger({ sink: createFileLogSink(join(dir, "logs")) });
      logger.warn("hi", { phone: "+391234567890" });
      await logger.close();
      const content = readFileSync(join(dir, "logs", "social-explorer.log"), "utf8");
      expect(content).toContain('"phone":"[redacted]"');
      expect(content).not.toContain("391234567890");
      expect(parseLogLevel("debug")).toBe("debug");
      expect(parseLogLevel("nonsense")).toBe("info");
      expect(parseLogLevel(undefined)).toBe("info");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
