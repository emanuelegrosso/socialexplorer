import type {
  AnalyticsRange,
  ContactMetrics,
  GlobalMetrics,
  GroupMetrics,
  RelationSet,
} from "@social-explorer/contracts";
import type { SqliteDatabase } from "@social-explorer/database";
import { loadEntityContext, loadMessageFacts } from "./facts.js";
import {
  computeContactMetrics,
  computeGlobalMetrics,
  computeGroupMetrics,
} from "./metrics.js";
import { rebuildAnalyticsTables, type RebuildResult } from "./rebuild.js";
import { computeRelations } from "./relations.js";

export interface AnalyticsEngine {
  rebuild(datasetId: string): RebuildResult;
  global(datasetId: string, range?: AnalyticsRange): GlobalMetrics;
  contact(datasetId: string, contactId: string, range?: AnalyticsRange): ContactMetrics;
  group(datasetId: string, conversationId: string, range?: AnalyticsRange): GroupMetrics;
  relations(datasetId: string, windowMinutes?: number): RelationSet;
}

export function createAnalyticsEngine(db: SqliteDatabase): AnalyticsEngine {
  return {
    rebuild: (datasetId) => rebuildAnalyticsTables(db, datasetId),
    global: (datasetId, range) =>
      computeGlobalMetrics(loadEntityContext(db, datasetId), loadMessageFacts(db, datasetId), range),
    contact: (datasetId, contactId, range) =>
      computeContactMetrics(loadEntityContext(db, datasetId), loadMessageFacts(db, datasetId), contactId, range),
    group: (datasetId, conversationId, range) =>
      computeGroupMetrics(loadEntityContext(db, datasetId), loadMessageFacts(db, datasetId), conversationId, range),
    relations: (datasetId, windowMinutes) =>
      computeRelations(loadEntityContext(db, datasetId), loadMessageFacts(db, datasetId), windowMinutes),
  };
}
