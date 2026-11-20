import { rmSync } from "node:fs";

/**
 * Deletes only the SQLite file and its WAL/SHM/journal siblings. It deliberately knows
 * nothing about connector auth storage, which lives in a separate directory.
 */
export function deleteDatabaseFiles(filePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    rmSync(`${filePath}${suffix}`, { force: true });
  }
}
