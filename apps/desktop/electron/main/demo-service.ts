import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { FirstRunStatus, DemoSeedResult } from "@social-explorer/contracts";
import type { Repositories, SqliteDatabase } from "@social-explorer/database";
import type { ArchiveImportService } from "./import-service.js";

export const SYNTHETIC_DEMO_NAME = "Synthetic demo";
const PREFERENCES_FILE = "first-run.json";
const FIXTURE_ZIP = "zips/android-private-with-media.zip";
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/synthetic");
const SELF_NAME = "Alice Example";

interface StoredPreferences {
  readonly state: FirstRunStatus["state"];
  readonly datasetId?: string;
}

function preferencesPath(userDataDir: string): string {
  return resolve(userDataDir, PREFERENCES_FILE);
}

function readPreferences(userDataDir: string): StoredPreferences {
  const path = preferencesPath(userDataDir);
  if (!existsSync(path)) {
    return { state: "pending" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredPreferences;
    return {
      state: parsed.state,
      ...(parsed.datasetId === undefined ? {} : { datasetId: parsed.datasetId }),
    };
  } catch {
    return { state: "pending" };
  }
}

function writePreferences(userDataDir: string, value: StoredPreferences): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(preferencesPath(userDataDir), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function getFirstRunStatus(
  userDataDir: string,
  repositories: Repositories,
): FirstRunStatus {
  const stored = readPreferences(userDataDir);
  if (stored.datasetId !== undefined) {
    const dataset = repositories.datasets.get(stored.datasetId);
    if (dataset !== undefined) {
      return { state: stored.state, datasetId: dataset.id, datasetName: dataset.name };
    }
  }
  const synthetic = repositories.datasets
    .list()
    .find((dataset) => dataset.name === SYNTHETIC_DEMO_NAME);
  if (synthetic !== undefined) {
    return { state: "seeded", datasetId: synthetic.id, datasetName: synthetic.name };
  }
  return { state: stored.state };
}

export async function seedSyntheticDemo(options: {
  readonly userDataDir: string;
  readonly repositories: Repositories;
  readonly db: SqliteDatabase;
  readonly imports: ArchiveImportService;
  readonly force?: boolean;
}): Promise<DemoSeedResult> {
  const existing = options.repositories.datasets
    .list()
    .find((dataset) => dataset.name === SYNTHETIC_DEMO_NAME);
  if (existing !== undefined && options.force !== true) {
    writePreferences(options.userDataDir, { state: "seeded", datasetId: existing.id });
    const mediaCount = options.repositories.media.listReferences(existing.id).length;
    const messageCount = options.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE dataset_id = ?")
      .get(existing.id) as { n: number };
    return {
      datasetId: existing.id,
      status: "already-seeded",
      messageCount: messageCount.n,
      mediaReferenceCount: mediaCount,
    };
  }
  if (existing !== undefined && options.force === true) {
    options.repositories.datasets.delete(existing.id);
  }

  const data = readFileSync(resolve(FIXTURE_ROOT, FIXTURE_ZIP));
  const stagedId = options.imports.stage({
    name: FIXTURE_ZIP.split("/").pop() ?? "android-private-with-media.zip",
    data: new Uint8Array(data),
  });
  await options.imports.preview(stagedId);
  const confirmed = await options.imports.confirm({
    stagedId,
    datasetName: SYNTHETIC_DEMO_NAME,
    timezone: "Europe/Rome",
    selfNames: [SELF_NAME],
  });
  const committed = await options.imports.commit({ stagedId, resolutions: {} });
  writePreferences(options.userDataDir, { state: "seeded", datasetId: confirmed.datasetId });
  return {
    datasetId: confirmed.datasetId,
    status: "seeded",
    messageCount: committed.persisted.messagesInserted,
    mediaReferenceCount: options.repositories.media.listReferences(confirmed.datasetId).length,
  };
}

export function skipFirstRun(userDataDir: string): FirstRunStatus {
  writePreferences(userDataDir, { state: "skipped" });
  return { state: "skipped" };
}

export function resetSyntheticDemo(
  userDataDir: string,
  repositories: Repositories,
): FirstRunStatus {
  const stored = readPreferences(userDataDir);
  const targets = new Set<string>();
  if (stored.datasetId !== undefined) {
    targets.add(stored.datasetId);
  }
  for (const dataset of repositories.datasets.list()) {
    if (dataset.name === SYNTHETIC_DEMO_NAME) {
      targets.add(dataset.id);
    }
  }
  for (const id of targets) {
    repositories.datasets.delete(id);
  }
  writePreferences(userDataDir, { state: "pending" });
  return { state: "pending" };
}