import { describe, expect, it } from "vitest";
import { readResumableImport, writeResumableImport } from "./resumable";
import { loadSyntheticSample, stageSyntheticInMock } from "./synthetic-sample";

describe("archive import UI helpers", () => {
  it("stores and reads resumable import metadata", () => {
    const memory = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => memory.get(key) ?? null,
        setItem: (key: string, value: string) => {
          memory.set(key, value);
        },
        removeItem: (key: string) => {
          memory.delete(key);
        },
      },
      configurable: true,
    });
    writeResumableImport({
      datasetId: "ds-1",
      datasetName: "Sample",
      stagedId: "stage-1",
      resumedFromChunk: 2,
      totalChunks: 5,
    });
    expect(readResumableImport()?.resumedFromChunk).toBe(2);
    writeResumableImport(undefined);
    expect(readResumableImport()).toBeUndefined();
  });

  it("stages a synthetic Android preview without touching the filesystem", () => {
    const sample = loadSyntheticSample();
    const staged = stageSyntheticInMock(sample);
    expect(staged.preview.platform).toBe("android");
    expect(staged.preview.confirmation.selfCandidates[0]?.recommended).toBe(true);
  });
});