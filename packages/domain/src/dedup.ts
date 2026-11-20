import { joinKey, sha256Hex } from "@social-explorer/shared";

export interface SourceMessageKey {
  readonly conversationKey: string;
  readonly sourceMessageId: string;
  readonly participantKey?: string;
}

/** Exact key for sources with stable message IDs (Baileys). */
export function messageDedupKey(key: SourceMessageKey): string {
  return joinKey([key.conversationKey, key.sourceMessageId, key.participantKey ?? ""]);
}

export interface FingerprintInput {
  readonly conversationKey: string;
  readonly timestampLocal: string;
  readonly senderName: string;
  readonly text: string;
}

/** Conservative fingerprint for exports without stable IDs. */
export function exportFingerprint(input: FingerprintInput): string {
  return sha256Hex(
    joinKey([
      input.conversationKey,
      input.timestampLocal,
      input.senderName.normalize("NFC").trim(),
      input.text.normalize("NFC"),
    ]),
  );
}

export type DuplicateClass = "new" | "exact-duplicate" | "ambiguous";

/**
 * Classifies a fingerprint against already known occurrences. A repeated fingerprint inside the
 * same batch is ambiguous (could be genuine repeated messages) and is never silently discarded.
 */
export function classifyDuplicate(
  fingerprint: string,
  existing: ReadonlyMap<string, number>,
  incomingCount: number,
): DuplicateClass {
  const known = existing.get(fingerprint);
  if (known === undefined) {
    return incomingCount > 1 ? "ambiguous" : "new";
  }
  return known === incomingCount ? "exact-duplicate" : "ambiguous";
}
