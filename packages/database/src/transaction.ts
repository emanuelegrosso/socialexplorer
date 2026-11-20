import type { SqliteDatabase } from "./open.js";

export function runInTransaction<T>(db: SqliteDatabase, work: () => T): T {
  return db.transaction(work)();
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError("chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Applies `work` to each chunk in its own transaction so a long import never holds one
 * giant write lock and a failure rolls back only the failing chunk.
 */
export function runChunked<T>(
  db: SqliteDatabase,
  items: readonly T[],
  chunkSize: number,
  work: (batch: readonly T[], chunkIndex: number) => void,
): number {
  let chunks = 0;
  for (const [index, batch] of chunk(items, chunkSize).entries()) {
    db.transaction(() => {
      work(batch, index);
    })();
    chunks += 1;
  }
  return chunks;
}
