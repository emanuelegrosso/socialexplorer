const KEY = "se:resumable-import";

export interface ResumableImport {
  readonly datasetId: string;
  readonly datasetName: string;
  readonly stagedId: string;
  readonly resumedFromChunk: number;
  readonly totalChunks: number;
}

export function readResumableImport(): ResumableImport | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) {
      return undefined;
    }
    return JSON.parse(raw) as ResumableImport;
  } catch {
    return undefined;
  }
}

export function writeResumableImport(value: ResumableImport | undefined): void {
  if (value === undefined) {
    localStorage.removeItem(KEY);
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(value));
}