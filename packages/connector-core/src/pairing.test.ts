import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "./backoff.js";
import { parseConnectorConfig } from "./config.js";
import { INITIAL_PAIRING_STATE, pairingReducer, pairingSnapshot } from "./pairing.js";

describe("pairing state machine", () => {
  it("walks idle -> awaiting-qr -> paired and rotates QR codes", () => {
    let state = pairingReducer(INITIAL_PAIRING_STATE, { type: "qr", qr: "q1" }, 3);
    expect(state).toMatchObject({ phase: "awaiting-qr", qrAttempts: 1, qr: "q1" });
    state = pairingReducer(state, { type: "qr", qr: "q2" }, 3);
    expect(state.qr).toBe("q2");
    state = pairingReducer(state, { type: "paired" }, 3);
    expect(state).toEqual({ phase: "paired", qrAttempts: 0 });
    expect(pairingReducer(state, { type: "qr", qr: "late" }, 3)).toBe(state);
  });

  it("times out after the QR budget and supports pairing-code mode", () => {
    let state = INITIAL_PAIRING_STATE;
    for (const qr of ["a", "b"]) {
      state = pairingReducer(state, { type: "qr", qr }, 2);
    }
    state = pairingReducer(state, { type: "qr", qr: "c" }, 2);
    expect(state.phase).toBe("timed-out");
    expect(pairingReducer(INITIAL_PAIRING_STATE, { type: "code-requested" }, 2).phase).toBe("awaiting-code");
    expect(pairingReducer(state, { type: "logged-out" }, 2).phase).toBe("logged-out");
    expect(pairingReducer(state, { type: "reset" }, 2)).toBe(INITIAL_PAIRING_STATE);
  });

  it("public snapshot never contains the QR payload", () => {
    const state = pairingReducer(INITIAL_PAIRING_STATE, { type: "qr", qr: "secret-qr" }, 3);
    expect(JSON.stringify(pairingSnapshot(state))).not.toContain("secret-qr");
    expect(pairingSnapshot(state).hasQr).toBe(true);
  });
});

describe("backoff", () => {
  const options = { baseMs: 1000, maxMs: 60_000, jitterRatio: 0.25 };

  it("grows exponentially and caps", () => {
    const noJitter = { ...options, jitterRatio: 0 };
    expect([1, 2, 3, 4, 7, 8, 50].map((attempt) => computeBackoffMs(attempt, noJitter))).toEqual([
      1000, 2000, 4000, 8000, 60_000, 60_000, 60_000,
    ]);
  });

  it("stays within jitter bounds and never exceeds the cap", () => {
    for (const random of [0, 0.25, 0.5, 0.999]) {
      const value = computeBackoffMs(3, options, () => random);
      expect(value).toBeGreaterThanOrEqual(3000);
      expect(value).toBeLessThanOrEqual(5000);
    }
    expect(computeBackoffMs(20, options, () => 0.999)).toBeLessThanOrEqual(60_000);
  });
});

describe("config", () => {
  it("defaults to disabled with sane supervision limits", () => {
    const config = parseConnectorConfig();
    expect(config.connectorEnabled).toBe(false);
    expect(config.reconnect.maxMs).toBe(60_000);
    expect(config.supervisor.maxRestarts).toBe(5);
    expect(() => parseConnectorConfig({ unknown: true })).toThrow();
  });
});
