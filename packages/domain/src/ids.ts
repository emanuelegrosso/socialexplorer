import { deterministicId } from "@social-explorer/shared";

export function datasetId(name: string, createdAt: string): string {
  return deterministicId("dataset", [name, createdAt]);
}

export function sourceId(datasetIdValue: string, label: string): string {
  return deterministicId("source", [datasetIdValue, label]);
}

export function conversationId(datasetIdValue: string, sourceConversationKey: string): string {
  return deterministicId("conv", [datasetIdValue, sourceConversationKey]);
}

export function contactId(
  datasetIdValue: string,
  identifierType: string,
  identifierValue: string,
): string {
  return deterministicId("contact", [datasetIdValue, identifierType, identifierValue]);
}

export function messageId(
  datasetIdValue: string,
  conversationIdValue: string,
  dedupKey: string,
): string {
  return deterministicId("msg", [datasetIdValue, conversationIdValue, dedupKey]);
}

export function provenanceId(
  datasetIdValue: string,
  sourceIdValue: string,
  locator: string,
): string {
  return deterministicId("prov", [datasetIdValue, sourceIdValue, locator]);
}
