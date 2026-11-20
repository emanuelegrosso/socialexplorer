import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { MediaStorytellingRepository } from "@social-explorer/database";
import { assertContentHash, resolveContained, THUMBNAIL_DIR } from "./paths.js";

export interface CleanupResult {
  readonly removedCopies: number;
  readonly removedThumbnails: number;
  readonly keptSharedCopies: number;
}

/**
 * Removes app-managed copied media and thumbnails for a dataset. Only files below `appRoot`
 * that this app generated are deleted; canonical messages, references (which only flip to
 * not-imported), contacts and connector credentials are never touched.
 */
export async function removeManagedMedia(
  repo: MediaStorytellingRepository,
  appRoot: string,
  datasetId: string,
): Promise<CleanupResult> {
  const assets = repo.listManagedAssets(datasetId);
  const owned = new Set(assets.map((asset) => asset.id));
  let removedCopies = 0;
  let removedThumbnails = 0;
  let keptSharedCopies = 0;
  for (const asset of assets) {
    const path = asset.storageRelativePath;
    if (path === undefined) {
      continue;
    }
    const shared = repo.countAssetsUsingStoragePath(path, [...owned]) > 0;
    if (shared) {
      keptSharedCopies++;
    } else {
      await rm(resolveContained(appRoot, path), { force: true });
      removedCopies++;
      if (asset.contentHash !== undefined) {
        removedThumbnails += await removeThumbnailsFor(appRoot, asset.contentHash);
      }
    }
    repo.markManagedCopyRemoved(asset.id);
  }
  return { removedCopies, removedThumbnails, keptSharedCopies };
}

export async function removeThumbnailsFor(appRoot: string, contentHash: string): Promise<number> {
  assertContentHash(contentHash);
  const dir = resolveContained(appRoot, `${THUMBNAIL_DIR}/${contentHash.slice(0, 2)}`);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.filter((entry) => entry.startsWith(`${contentHash}-`))) {
    await rm(join(dir, name), { force: true });
    removed++;
  }
  return removed;
}
