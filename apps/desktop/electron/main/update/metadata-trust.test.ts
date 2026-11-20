import { describe, expect, it } from "vitest";
import { validateUpdateMetadataTrust } from "./metadata-trust.js";

describe("validateUpdateMetadataTrust", () => {
  const good = {
    version: "1.2.0",
    releaseDate: "2026-01-01T00:00:00Z",
    releaseNotes: "Fixes and improvements",
    files: [
      {
        url: "https://cdn.example/SocialExplorer-Setup-1.2.0.exe",
        sha512: "a".repeat(88),
        size: 12345,
      },
    ],
  };

  it("accepts signed digests", () => {
    const result = validateUpdateMetadataTrust(good, { requireSha512: true });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed metadata", () => {
    const result = validateUpdateMetadataTrust({ version: 1 }, { requireSha512: true });
    expect(result).toEqual({ ok: false, reason: "malformed_metadata" });
  });

  it("rejects missing digest", () => {
    const result = validateUpdateMetadataTrust(
      { version: "1.0.0", releaseDate: "2026-01-01", releaseNotes: "x" },
      { requireSha512: true },
    );
    expect(result).toEqual({ ok: false, reason: "missing_digest" });
  });

  it("rejects untrusted publisher attestation", () => {
    const result = validateUpdateMetadataTrust(good, {
      requireSha512: true,
      expectedPublisherAttestation: "ci-job-1",
      publisherAttestation: "wrong",
    });
    expect(result).toEqual({ ok: false, reason: "untrusted_publisher" });
  });
});