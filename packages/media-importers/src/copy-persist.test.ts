import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMediaStorytellingRepository } from "@social-explorer/database";
import { createMediaCatalog, removeManagedMedia } from "@social-explorer/media-core";
import {
  copyDiscoveredMedia,
  discoverMedia,
  persistMediaRecords,
  planMediaRecords,
  type MediaDiscovery,
} from "./index.js";
import {
  chatZip,
  countRows,
  FIXTURE_ZIPS,
  loadFixture,
  parse,
  PNG_1X1,
  seedMessagesFor,
} from "./helpers.testutil.js";
import { createSeededDatabase, T0 } from "./seed.testutil.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "se-media-copy-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

async function discover(name: (typeof FIXTURE_ZIPS)[number]): Promise<MediaDiscovery> {
  const input = loadFixture(name);
  return discoverMedia({ archive: input, parsed: await parse(input) });
}

describe("opt-in copy", () => {
  it("writes hash-named files under media/ and nothing without opt-in", async () => {
    const discovery = await discover("android-private-with-media.zip");
    expect(allFiles(root)).toEqual([]);
    const result = await copyDiscoveredMedia(discovery, { appRoot: root });
    expect(result).toMatchObject({ copied: 2, reused: 0, failed: [], bytesWritten: 69 + 1644 });
    const files = allFiles(root)
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(/^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.(png|wav)$/u);
      expect(file).not.toMatch(/IMG|PTT|WA000/u);
    }
    for (const [hash, relative] of result.paths) {
      expect(
        createHash("sha256")
          .update(readFileSync(join(root, relative)))
          .digest("hex"),
      ).toBe(hash);
    }
    const again = await copyDiscoveredMedia(discovery, { appRoot: root });
    expect(again).toMatchObject({ copied: 0, reused: 2, bytesWritten: 0 });
  });

  it("deduplicates identical content under different original names", async () => {
    const input = chatZip(
      ["../../x.png (file attached)", "a.png (file attached)", "b.png (file attached)"],
      [
        { name: "a.png", data: PNG_1X1 },
        { name: "b.png", data: PNG_1X1 },
      ],
    );
    const discovery = await discoverMedia({ archive: input, parsed: await parse(input) });
    const result = await copyDiscoveredMedia(discovery, { appRoot: root });
    expect(result.copied).toBe(1);
    expect(allFiles(root)).toHaveLength(1);
    expect(existsSync(join(root, "..", "x.png"))).toBe(false);
  });

  it("rejects a source that changed after discovery and leaves no partial file", async () => {
    const folder = join(root, "companion");
    mkdirSync(folder);
    writeFileSync(join(folder, "p.png"), PNG_1X1);
    const input = {
      name: "chat.txt",
      data: Buffer.from("15/01/2026, 09:20 - Alice Example: p.png (file attached)"),
    };
    const discovery = await discoverMedia({
      archive: input,
      parsed: await parse(input),
      companionDir: folder,
    });
    writeFileSync(join(folder, "p.png"), Buffer.concat([PNG_1X1]).fill(1));
    const appRoot = join(root, "app");
    const result = await copyDiscoveredMedia(discovery, { appRoot });
    expect(result.failed).toHaveLength(1);
    expect(result.copied).toBe(0);
    expect(allFiles(appRoot)).toEqual([]);
  });
});

describe("persistence of discovery (copy vs reference-only)", () => {
  it("reference-only: records hashes and truthful availability, copies nothing", async () => {
    const { db, repos } = createSeededDatabase();
    const discovery = await discover("android-private-with-media.zip");
    const plan = planMediaRecords(discovery, {
      datasetId: "ds-1",
      provenanceId: "prov-1",
      importedAt: T0,
      mode: "reference-only",
      resolveMessage: seedMessagesFor(repos, discovery),
    });
    persistMediaRecords(db, "ds-1", plan);
    expect(allFiles(root)).toEqual([]);
    const repo = createMediaStorytellingRepository(db);
    const assets = repo.listAssets("ds-1");
    expect(assets).toHaveLength(2);
    for (const asset of assets) {
      expect(asset.availability).toBe("not-imported");
      expect(asset.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(asset.storageRelativePath).toBeUndefined();
    }
    const entries = createMediaCatalog(db).query({ datasetId: "ds-1" });
    expect(entries.map((e) => e.reference.availability)).toEqual([
      "not-imported",
      "not-imported",
      "not-imported",
    ]);
    expect(entries.filter((e) => e.asset === undefined)).toHaveLength(1);
  });

  it("copy: assets are available-local; re-running is idempotent; cleanup keeps messages", async () => {
    const { db, repos } = createSeededDatabase();
    const discovery = await discover("android-group-with-media.zip");
    const copy = await copyDiscoveredMedia(discovery, { appRoot: root });
    const resolve = seedMessagesFor(repos, discovery);
    const context = {
      datasetId: "ds-1",
      provenanceId: "prov-1",
      importedAt: T0,
      mode: "copy" as const,
      copy,
      resolveMessage: resolve,
    };
    persistMediaRecords(db, "ds-1", planMediaRecords(discovery, context));
    persistMediaRecords(db, "ds-1", planMediaRecords(discovery, context));
    expect(countRows(db, "media_assets")).toBe(2);
    expect(countRows(db, "media_references")).toBe(3);
    const catalog = createMediaCatalog(db);
    const video = catalog.query({ datasetId: "ds-1", mediaType: "video" });
    expect(video).toHaveLength(1);
    expect(video[0]?.asset).toMatchObject({
      availability: "available-local",
      mimeType: "video/mp4",
    });
    expect(video[0]?.asset?.storageRelativePath).toMatch(
      /^media\/[0-9a-f]{2}\/[0-9a-f]{64}\.mp4$/u,
    );
    const messageId = video[0]?.reference.messageId ?? "";
    expect(catalog.mediaForMessage(messageId)).toHaveLength(1);
    expect(catalog.messagesForAsset(video[0]?.asset?.id ?? "").map((m) => m.id)).toEqual([
      messageId,
    ]);
    expect(catalog.query({ datasetId: "ds-1", mediaType: "audio" })).toHaveLength(1);

    const messages = countRows(db, "messages");
    const cleanup = await removeManagedMedia(createMediaStorytellingRepository(db), root, "ds-1");
    expect(cleanup.removedCopies).toBe(2);
    expect(allFiles(root)).toEqual([]);
    expect(countRows(db, "messages")).toBe(messages);
    expect(countRows(db, "media_references")).toBe(3);
    expect(catalog.countByAvailability("ds-1")["available-local"]).toBe(0);
  });

  it("records missing and unsupported references without assets", async () => {
    const { db, repos } = createSeededDatabase();
    const input = chatZip(
      ["ghost.png (file attached)", "bad.png (file attached)", "<Media omitted>"],
      [{ name: "bad.png", data: "not an image" }],
    );
    const discovery = await discoverMedia({ archive: input, parsed: await parse(input) });
    const plan = planMediaRecords(discovery, {
      datasetId: "ds-1",
      provenanceId: "prov-1",
      importedAt: T0,
      mode: "reference-only",
      resolveMessage: seedMessagesFor(repos, discovery),
    });
    persistMediaRecords(db, "ds-1", plan);
    expect(plan.assets).toEqual([]);
    expect(createMediaCatalog(db).countByAvailability("ds-1")).toEqual({
      "available-local": 0,
      "external-link": 0,
      missing: 1,
      unsupported: 1,
      "not-imported": 1,
    });
  });

  it("skips unresolved messages and demands a copy result in copy mode", async () => {
    const discovery = await discover("ios-group-with-media.zip");
    const plan = planMediaRecords(discovery, {
      datasetId: "ds-1",
      provenanceId: "prov-1",
      importedAt: T0,
      mode: "reference-only",
      resolveMessage: () => undefined,
    });
    expect(plan.skippedReferences).toBe(2);
    expect(plan.references).toEqual([]);
    expect(() =>
      planMediaRecords(discovery, {
        datasetId: "ds-1",
        provenanceId: "prov-1",
        importedAt: T0,
        mode: "copy",
        resolveMessage: () => undefined,
      }),
    ).toThrow(/copy mode/u);
  });
});
