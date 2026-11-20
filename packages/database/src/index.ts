import { rebuildAnalytics } from "./analytics.js";
import type { SqliteDatabase } from "./open.js";
import {
  createAnnotationRepository,
  createContactRepository,
  createConversationRepository,
  createDatasetRepository,
  createImportBatchRepository,
  createProvenanceRepository,
  createSourceRepository,
} from "./repositories-core.js";
import { createMediaRepository } from "./repositories-media.js";
import { createMessageRepository } from "./repositories-messages.js";
import { createSettingsRepository, createSyncRepository } from "./repositories-sync.js";

export * from "./analytics.js";
export * from "./files.js";
export * from "./migrate.js";
export * from "./open.js";
export * from "./repositories-core.js";
export * from "./repositories-media.js";
export * from "./repositories-messages.js";
export * from "./repositories-sync.js";
export * from "./transaction.js";

export interface Repositories {
  readonly datasets: ReturnType<typeof createDatasetRepository>;
  readonly sources: ReturnType<typeof createSourceRepository>;
  readonly importBatches: ReturnType<typeof createImportBatchRepository>;
  readonly provenance: ReturnType<typeof createProvenanceRepository>;
  readonly contacts: ReturnType<typeof createContactRepository>;
  readonly conversations: ReturnType<typeof createConversationRepository>;
  readonly messages: ReturnType<typeof createMessageRepository>;
  readonly sync: ReturnType<typeof createSyncRepository>;
  readonly settings: ReturnType<typeof createSettingsRepository>;
  readonly annotations: ReturnType<typeof createAnnotationRepository>;
  readonly media: ReturnType<typeof createMediaRepository>;
  readonly rebuildAnalytics: (datasetId: string) => { daily: number; hourly: number };
}

export function createRepositories(db: SqliteDatabase): Repositories {
  return {
    datasets: createDatasetRepository(db),
    sources: createSourceRepository(db),
    importBatches: createImportBatchRepository(db),
    provenance: createProvenanceRepository(db),
    contacts: createContactRepository(db),
    conversations: createConversationRepository(db),
    messages: createMessageRepository(db),
    sync: createSyncRepository(db),
    settings: createSettingsRepository(db),
    annotations: createAnnotationRepository(db),
    media: createMediaRepository(db),
    rebuildAnalytics: (datasetId) => rebuildAnalytics(db, datasetId),
  };
}
