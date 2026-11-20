import type { Confidence, ContactIdentifier } from "@social-explorer/contracts";
import { classifyIdentifier, identifierKey, normalizeExportName } from "./identity.js";
import { compareIdentities } from "./resolution.js";

export interface KnownContact {
  readonly id: string;
  readonly displayName: string;
  readonly identifiers: readonly ContactIdentifier[];
  /** Set when this contact was manually merged into another one (reversible). */
  readonly mergedIntoContactId?: string | null;
}

export interface IdentifierMatch {
  readonly contactId: string;
  readonly type: ContactIdentifier["type"];
  readonly value: string;
  readonly confidence: Confidence;
  /** Only an identical phone number or JID may ever be linked without a human decision. */
  readonly autoLinkable: boolean;
  readonly reason: string;
}

const MATCH_CONFIDENCE: Readonly<Record<ContactIdentifier["type"], Confidence>> = {
  phone: "confirmed",
  jid: "confirmed",
  lid: "probable",
  other: "probable",
  "export-name": "unknown",
};

const AUTO_LINKABLE = new Set<ContactIdentifier["type"]>(["phone", "jid"]);

export function normalizeIdentifier(
  identifier: Pick<ContactIdentifier, "type" | "value">,
): Pick<ContactIdentifier, "type" | "value"> {
  switch (identifier.type) {
    case "export-name":
      return { type: "export-name", value: normalizeExportName(identifier.value) };
    case "other":
      return { type: "other", value: identifier.value.trim() };
    default:
      return classifyIdentifier(identifier.value);
  }
}

/**
 * Finds every known contact sharing one of the incoming identifiers. A display-name
 * (`export-name`) match is reported with `unknown` confidence and is never auto-linkable: two
 * different people can share a name, so merging by display name alone is forbidden.
 */
export function matchIdentifiers(
  incoming: readonly Pick<ContactIdentifier, "type" | "value">[],
  known: readonly KnownContact[],
): IdentifierMatch[] {
  const wanted = new Map(
    incoming.map((raw) => {
      const normalized = normalizeIdentifier(raw);
      return [identifierKey(normalized), normalized] as const;
    }),
  );
  const matches: IdentifierMatch[] = [];
  for (const contact of known) {
    for (const identifier of contact.identifiers) {
      const normalized = normalizeIdentifier(identifier);
      if (!wanted.has(identifierKey(normalized))) {
        continue;
      }
      matches.push({
        contactId: contact.id,
        type: normalized.type,
        value: normalized.value,
        confidence: MATCH_CONFIDENCE[normalized.type],
        autoLinkable: AUTO_LINKABLE.has(normalized.type),
        reason:
          normalized.type === "export-name"
            ? "display name only; requires manual review"
            : `identical ${normalized.type}`,
      });
    }
  }
  return matches.sort(
    (a, b) => a.contactId.localeCompare(b.contactId) || a.type.localeCompare(b.type),
  );
}

export type IdentityResolution =
  | { readonly kind: "linked"; readonly contactId: string; readonly matches: IdentifierMatch[] }
  | { readonly kind: "new"; readonly matches: IdentifierMatch[] }
  | { readonly kind: "needs-review"; readonly matches: IdentifierMatch[] };

/**
 * Auto-links only when exactly one contact shares a phone/JID. Anything else that matched
 * (name, LID, several contacts) is surfaced for review and never merged automatically.
 */
export function resolveIdentity(
  incoming: readonly Pick<ContactIdentifier, "type" | "value">[],
  known: readonly KnownContact[],
): IdentityResolution {
  const matches = matchIdentifiers(incoming, known);
  const strong = new Set(matches.filter((match) => match.autoLinkable).map((m) => m.contactId));
  const only = [...strong][0];
  if (strong.size === 1 && only !== undefined) {
    return { kind: "linked", contactId: only, matches };
  }
  if (matches.length === 0) {
    return { kind: "new", matches };
  }
  return { kind: "needs-review", matches };
}

export interface MergeSuggestion {
  readonly leftContactId: string;
  readonly rightContactId: string;
  readonly confidence: Confidence;
  readonly reason: string;
}

/** Suggestions only; the caller must perform an explicit manual merge. */
export function suggestMerges(known: readonly KnownContact[]): MergeSuggestion[] {
  const active = known
    .filter((contact) => contact.mergedIntoContactId === undefined || contact.mergedIntoContactId === null)
    .sort((a, b) => a.id.localeCompare(b.id));
  const out: MergeSuggestion[] = [];
  for (const [index, left] of active.entries()) {
    for (const right of active.slice(index + 1)) {
      const match = compareIdentities(left.identifiers, right.identifiers);
      if (match.decision !== "distinct") {
        out.push({
          leftContactId: left.id,
          rightContactId: right.id,
          confidence: match.confidence,
          reason: match.reason,
        });
      }
    }
  }
  return out;
}

export type MergeErrorCode =
  | "same_contact"
  | "unknown_contact"
  | "primary_is_merged"
  | "secondary_already_merged"
  | "secondary_has_merged_contacts"
  | "self_contact_cannot_be_secondary";

export interface MergeSubject {
  readonly id: string;
  readonly isSelf: boolean;
  readonly mergedIntoContactId: string | null;
}

export class ContactMergeError extends Error {
  override readonly name = "ContactMergeError";
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function validateMerge(input: {
  readonly primary: MergeSubject | undefined;
  readonly secondary: MergeSubject | undefined;
  readonly secondaryHasMergedContacts: boolean;
}): void {
  const { primary, secondary } = input;
  if (primary === undefined || secondary === undefined) {
    throw new ContactMergeError("unknown_contact", "contact not found in this dataset");
  }
  if (primary.id === secondary.id) {
    throw new ContactMergeError("same_contact", "cannot merge a contact into itself");
  }
  if (primary.mergedIntoContactId !== null) {
    throw new ContactMergeError("primary_is_merged", "the primary contact is itself merged");
  }
  if (secondary.mergedIntoContactId !== null) {
    throw new ContactMergeError("secondary_already_merged", "contact is already merged");
  }
  if (input.secondaryHasMergedContacts) {
    throw new ContactMergeError(
      "secondary_has_merged_contacts",
      "unmerge the contacts merged into the secondary first",
    );
  }
  if (secondary.isSelf && !primary.isSelf) {
    throw new ContactMergeError(
      "self_contact_cannot_be_secondary",
      "the exporting user's contact must stay the primary",
    );
  }
}

/** Follows `mergedInto` links (at most one level is ever created, cycles are tolerated). */
export function effectiveContactId(
  contactId: string,
  mergedInto: ReadonlyMap<string, string>,
): string {
  let current = contactId;
  const seen = new Set<string>();
  for (let next = mergedInto.get(current); next !== undefined; next = mergedInto.get(current)) {
    if (seen.has(next)) {
      break;
    }
    seen.add(current);
    current = next;
  }
  return current;
}
