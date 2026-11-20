import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** Writes via a same-directory temp file + fsync + rename so readers never see partial data. */
export function writeFileAtomic(filePath: string, data: Buffer): void {
  const tempPath = join(dirname(filePath), `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, data, { mode: 0o600 });
    const handle = openSync(tempPath, "r+");
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(tempPath, filePath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function removeFileIfExists(filePath: string): void {
  rmSync(filePath, { force: true });
}
