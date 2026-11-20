import { createHash } from "node:crypto";
import {
  normalizeSenderKey,
  type NormalizedConversation,
  type NormalizedMessage,
} from "./confirmation.js";
import type { TimestampPrecision } from "./types.js";

export interface ExistingMessageRef {
  readonly id: string;
  readonly conversationKey: string;
  readonly senderName: string | null;
  readonly text: string;
  readonly contentKey: string;
  readonly timestampUtc: string | null;
  readonly timestampPrecision: TimestampPrecision | null;
}

export interface ExistingContactRef {
  readonly id: string;
  readonly displayName: string;
}

/**
 * Read-only view of what is already stored. Wave 4 implements this against
 * `@social-explorer/database`; the importer never touches storage directly.
 */
export interface ExistingDatasetIndex {
  findByContentKeys(
    conversationKey: string,
    contentKeys: readonly string[],
  ): Promise<readonly ExistingMessageRef[]>;
  findInTimeWindow(
    conversationKey: string,
    fromUtc: string,
    toUtc: string,
  ): Promise<readonly ExistingMessageRef[]>;
  /** Keys of the returned map are `normalizeSenderKey(displayName)`. */
  findContactsByDisplayName(
    displayNames: readonly string[],
  ): Promise<ReadonlyMap<string, readonly ExistingContactRef[]>>;
}

export type MergeClassification = "new" | "exact_duplicate" | "ambiguous";
export type AmbiguityReason =
  "near_timestamp_same_sender" | "same_content_near_timestamp" | "repeated_content_surplus";

export interface MergeItem {
  readonly message: NormalizedMessage;
  readonly classification: MergeClassification;
  readonly existingId: string | null;
  readonly reason: AmbiguityReason | null;
  readonly candidates: readonly ExistingMessageRef[];
}

export interface ContactDecision {
  readonly displayName: string;
  readonly status: "new" | "matched_by_display_name" | "ambiguous";
  readonly candidates: readonly ExistingContactRef[];
}

export type MergeReviewItem =
  | {
      readonly reviewId: string;
      readonly kind: "message";
      readonly item: MergeItem;
    }
  | {
      readonly reviewId: string;
      readonly kind: "contact";
      readonly contact: ContactDecision;
    };

export interface MergeCounts {
  readonly new: number;
  readonly exact_duplicate: number;
  readonly ambiguous: number;
}

export interface MergeReviewPlan {
  readonly planId: string;
  readonly items: readonly MergeItem[];
  readonly contacts: readonly ContactDecision[];
  readonly reviews: readonly MergeReviewItem[];
  readonly counts: MergeCounts;
}

export type MergeResolution =
  | { readonly action: "keep_both" }
  | { readonly action: "skip_incoming" }
  | { readonly action: "link_existing"; readonly existingId: string };

export type MergeResolutions = Readonly<Record<string, MergeResolution>>;

export interface MergeOptions {
  /** Same-sender messages within this many seconds of an existing one are ambiguous. */
  readonly ambiguousWindowSeconds?: number;
  readonly queryBatchSize?: number;
}

export class MergeResolutionError extends Error {
  override readonly name = "MergeResolutionError";
}

function utcMs(value: string): number {
  return Date.parse(value);
}

function sameInstant(
  a: { timestampUtc: string | null; timestampPrecision: TimestampPrecision | null },
  b: { timestampUtc: string | null; timestampPrecision: TimestampPrecision | null },
): boolean {
  if (a.timestampUtc === null || b.timestampUtc === null) {
    return a.timestampUtc === b.timestampUtc;
  }
  if (a.timestampPrecision === "minute" || b.timestampPrecision === "minute") {
    return (
      Math.floor(utcMs(a.timestampUtc) / 60_000) === Math.floor(utcMs(b.timestampUtc) / 60_000)
    );
  }
  return utcMs(a.timestampUtc) === utcMs(b.timestampUtc);
}

function withinWindow(
  a: { timestampUtc: string | null; timestampPrecision: TimestampPrecision | null },
  b: { timestampUtc: string | null; timestampPrecision: TimestampPrecision | null },
  windowMs: number,
): boolean {
  if (a.timestampUtc === null || b.timestampUtc === null) {
    return false;
  }
  if (sameInstant(a, b)) {
    return true;
  }
  return Math.abs(utcMs(a.timestampUtc) - utcMs(b.timestampUtc)) <= windowMs;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

const byTimeThenId = (a: ExistingMessageRef, b: ExistingMessageRef): number =>
  (a.timestampUtc ?? "").localeCompare(b.timestampUtc ?? "") || a.id.localeCompare(b.id);

async function classifyConversation(
  conversation: NormalizedConversation,
  index: ExistingDatasetIndex,
  windowMs: number,
  batchSize: number,
): Promise<MergeItem[]> {
  const messages = conversation.messages;
  const contentKeys = [...new Set(messages.map((message) => message.contentKey))];
  const byContent = new Map<string, ExistingMessageRef[]>();
  for (const batch of chunk(contentKeys, batchSize)) {
    for (const ref of await index.findByContentKeys(conversation.conversationKey, batch)) {
      const list = byContent.get(ref.contentKey) ?? [];
      list.push(ref);
      byContent.set(ref.contentKey, list);
    }
  }
  for (const list of byContent.values()) {
    list.sort(byTimeThenId);
  }

  const consumed = new Set<string>();
  const results = new Map<string, MergeItem>();
  const unresolved: NormalizedMessage[] = [];

  for (const message of messages) {
    const candidates = byContent.get(message.contentKey) ?? [];
    const match = candidates.find((ref) => !consumed.has(ref.id) && sameInstant(ref, message));
    if (match) {
      consumed.add(match.id);
      results.set(message.recordId, {
        message,
        classification: "exact_duplicate",
        existingId: match.id,
        reason: null,
        candidates: [match],
      });
      continue;
    }
    const exhausted = candidates.filter((ref) => consumed.has(ref.id) && sameInstant(ref, message));
    if (exhausted.length > 0) {
      results.set(message.recordId, {
        message,
        classification: "ambiguous",
        existingId: null,
        reason: "repeated_content_surplus",
        candidates: exhausted,
      });
      continue;
    }
    unresolved.push(message);
  }

  const timed = unresolved.filter((message) => message.timestampUtc !== null);
  let windowRefs: ExistingMessageRef[] = [];
  if (timed.length > 0) {
    const stamps = timed.map((message) => utcMs(message.timestampUtc ?? ""));
    const from = new Date(Math.min(...stamps) - windowMs - 60_000).toISOString();
    const to = new Date(Math.max(...stamps) + windowMs + 60_000).toISOString();
    windowRefs = [...(await index.findInTimeWindow(conversation.conversationKey, from, to))].sort(
      byTimeThenId,
    );
  }

  for (const message of unresolved) {
    const near = windowRefs.filter(
      (ref) =>
        !consumed.has(ref.id) &&
        normalizeSenderKey(ref.senderName) === normalizeSenderKey(message.senderName) &&
        withinWindow(ref, message, windowMs),
    );
    if (near.length > 0) {
      const sameContent = near.some((ref) => ref.contentKey === message.contentKey);
      results.set(message.recordId, {
        message,
        classification: "ambiguous",
        existingId: null,
        reason: sameContent ? "same_content_near_timestamp" : "near_timestamp_same_sender",
        candidates: near,
      });
    } else {
      results.set(message.recordId, {
        message,
        classification: "new",
        existingId: null,
        reason: null,
        candidates: [],
      });
    }
  }

  return messages.map((message) => {
    const item = results.get(message.recordId);
    if (item === undefined) {
      throw new Error(`Unclassified record ${message.recordId}`);
    }
    return item;
  });
}

/** Deterministically classifies every incoming record; nothing is ever discarded here. */
export async function buildMergeReviewPlan(
  conversations: readonly NormalizedConversation[],
  index: ExistingDatasetIndex,
  options: MergeOptions = {},
): Promise<MergeReviewPlan> {
  const windowMs = (options.ambiguousWindowSeconds ?? 60) * 1000;
  const batchSize = options.queryBatchSize ?? 500;
  const items: MergeItem[] = [];
  for (const conversation of conversations) {
    items.push(...(await classifyConversation(conversation, index, windowMs, batchSize)));
  }

  const names = new Map<string, string>();
  for (const conversation of conversations) {
    for (const message of conversation.messages) {
      if (message.direction !== "system" && message.senderName !== null) {
        const key = normalizeSenderKey(message.senderName);
        if (!names.has(key)) {
          names.set(key, message.senderName);
        }
      }
    }
  }
  const existingContacts =
    names.size > 0
      ? await index.findContactsByDisplayName([...names.values()])
      : new Map<string, readonly ExistingContactRef[]>();
  const contacts: ContactDecision[] = [...names.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, displayName]) => {
      const candidates = existingContacts.get(key) ?? [];
      return {
        displayName,
        candidates,
        status:
          candidates.length === 0
            ? "new"
            : candidates.length === 1
              ? "matched_by_display_name"
              : "ambiguous",
      };
    });

  const reviews: MergeReviewItem[] = [
    ...items
      .filter((item) => item.classification === "ambiguous")
      .map((item): MergeReviewItem => ({ reviewId: item.message.recordId, kind: "message", item })),
    ...contacts
      .filter((contact) => contact.status === "ambiguous")
      .map((contact): MergeReviewItem => ({
        reviewId: `contact:${normalizeSenderKey(contact.displayName)}`,
        kind: "contact",
        contact,
      })),
  ];
  const counts: MergeCounts = {
    new: items.filter((item) => item.classification === "new").length,
    exact_duplicate: items.filter((item) => item.classification === "exact_duplicate").length,
    ambiguous: items.filter((item) => item.classification === "ambiguous").length,
  };
  const planId = createHash("sha256")
    .update(
      items
        .map((item) => `${item.message.recordId}:${item.classification}:${item.existingId ?? ""}`)
        .join("|"),
    )
    .digest("hex")
    .slice(0, 32);
  return { planId, items, contacts, reviews, counts };
}

export type CommitItem =
  | { readonly kind: "insert"; readonly message: NormalizedMessage }
  | {
      readonly kind: "link";
      readonly message: NormalizedMessage;
      readonly existingId: string;
      readonly reason: "exact_duplicate" | "user_link";
    };

export interface ContactResolution {
  readonly displayName: string;
  readonly action: "create" | "link";
  readonly existingId: string | null;
}

export interface ResolvedMergePlan {
  readonly planId: string;
  /** Inserts and provenance links, in stable import order. */
  readonly commitItems: readonly CommitItem[];
  readonly skipped: readonly {
    readonly message: NormalizedMessage;
    readonly reason: "user_skip";
  }[];
  readonly contacts: readonly ContactResolution[];
  readonly unresolved: readonly MergeReviewItem[];
  readonly complete: boolean;
}

/** Applies explicit user decisions. Unresolved ambiguous records block completion. */
export function resolveMergePlan(
  plan: MergeReviewPlan,
  resolutions: MergeResolutions = {},
): ResolvedMergePlan {
  const reviewsById = new Map(plan.reviews.map((review) => [review.reviewId, review]));
  for (const [id, resolution] of Object.entries(resolutions)) {
    const review = reviewsById.get(id);
    if (review === undefined) {
      throw new MergeResolutionError(`Resolution for unknown review item "${id}"`);
    }
    if (resolution.action === "link_existing") {
      const ids =
        review.kind === "message"
          ? review.item.candidates.map((candidate) => candidate.id)
          : review.contact.candidates.map((candidate) => candidate.id);
      if (!ids.includes(resolution.existingId)) {
        throw new MergeResolutionError(`"${resolution.existingId}" is not a candidate for "${id}"`);
      }
    }
    if (resolution.action === "skip_incoming" && review.kind === "contact") {
      throw new MergeResolutionError(
        "Contacts cannot be skipped; choose keep_both or link_existing",
      );
    }
  }

  const commitItems: CommitItem[] = [];
  const skipped: { message: NormalizedMessage; reason: "user_skip" }[] = [];
  const unresolved: MergeReviewItem[] = [];

  for (const item of plan.items) {
    if (item.classification === "new") {
      commitItems.push({ kind: "insert", message: item.message });
    } else if (item.classification === "exact_duplicate") {
      commitItems.push({
        kind: "link",
        message: item.message,
        existingId: item.existingId ?? "",
        reason: "exact_duplicate",
      });
    } else {
      const resolution = resolutions[item.message.recordId];
      if (resolution === undefined) {
        const review = reviewsById.get(item.message.recordId);
        if (review) {
          unresolved.push(review);
        }
      } else if (resolution.action === "keep_both") {
        commitItems.push({ kind: "insert", message: item.message });
      } else if (resolution.action === "skip_incoming") {
        skipped.push({ message: item.message, reason: "user_skip" });
      } else {
        commitItems.push({
          kind: "link",
          message: item.message,
          existingId: resolution.existingId,
          reason: "user_link",
        });
      }
    }
  }

  const contacts: ContactResolution[] = [];
  for (const contact of plan.contacts) {
    if (contact.status === "new") {
      contacts.push({ displayName: contact.displayName, action: "create", existingId: null });
    } else if (contact.status === "matched_by_display_name") {
      contacts.push({
        displayName: contact.displayName,
        action: "link",
        existingId: contact.candidates[0]?.id ?? null,
      });
    } else {
      const reviewId = `contact:${normalizeSenderKey(contact.displayName)}`;
      const resolution = resolutions[reviewId];
      if (resolution === undefined) {
        const review = reviewsById.get(reviewId);
        if (review) {
          unresolved.push(review);
        }
      } else if (resolution.action === "link_existing") {
        contacts.push({
          displayName: contact.displayName,
          action: "link",
          existingId: resolution.existingId,
        });
      } else {
        contacts.push({ displayName: contact.displayName, action: "create", existingId: null });
      }
    }
  }

  return {
    planId: plan.planId,
    commitItems,
    skipped,
    contacts,
    unresolved,
    complete: unresolved.length === 0,
  };
}
