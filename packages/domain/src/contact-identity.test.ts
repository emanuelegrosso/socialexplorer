import { describe, expect, it } from "vitest";
import {
  ContactMergeError,
  effectiveContactId,
  matchIdentifiers,
  resolveIdentity,
  suggestMerges,
  validateMerge,
  type KnownContact,
} from "./contact-identity.js";

const known: KnownContact[] = [
  {
    id: "c1",
    displayName: "Alice Example",
    identifiers: [
      { type: "phone", value: "+15550100001", confidence: "confirmed" },
      { type: "export-name", value: "Alice Example", confidence: "unknown" },
    ],
  },
  {
    id: "c2",
    displayName: "Alice Example",
    identifiers: [{ type: "export-name", value: "Alice Example", confidence: "unknown" }],
  },
  {
    id: "c3",
    displayName: "Bob Sample",
    identifiers: [{ type: "lid", value: "00000002@lid", confidence: "probable" }],
  },
];

describe("identifier matching", () => {
  it("auto-links only a unique phone/jid match with confirmed confidence", () => {
    const result = resolveIdentity([{ type: "phone", value: "+1 555-0100001" }], known);
    expect(result).toMatchObject({ kind: "linked", contactId: "c1" });
    expect(result.matches[0]).toMatchObject({ confidence: "confirmed", autoLinkable: true });
  });

  it("never auto-links by display name alone, even when several contacts share it", () => {
    const result = resolveIdentity([{ type: "export-name", value: "Alice Example" }], known);
    expect(result.kind).toBe("needs-review");
    expect(result.matches.map((m) => [m.contactId, m.confidence, m.autoLinkable])).toEqual([
      ["c1", "unknown", false],
      ["c2", "unknown", false],
    ]);
  });

  it("treats LID matches as probable and manual-review only", () => {
    const [match] = matchIdentifiers([{ type: "lid", value: "00000002@lid" }], known);
    expect(match).toMatchObject({ contactId: "c3", confidence: "probable", autoLinkable: false });
    expect(resolveIdentity([{ type: "lid", value: "00000002@lid" }], known).kind).toBe(
      "needs-review",
    );
  });

  it("reports unknown identities as new", () => {
    expect(resolveIdentity([{ type: "export-name", value: "Nobody" }], known).kind).toBe("new");
  });

  it("only suggests merges and does not suggest distinct contacts", () => {
    const suggestions = suggestMerges(known);
    expect(suggestions).toEqual([
      expect.objectContaining({ leftContactId: "c1", rightContactId: "c2", confidence: "unknown" }),
    ]);
  });
});

describe("merge validation", () => {
  const free = (id: string, isSelf = false) => ({ id, isSelf, mergedIntoContactId: null });
  it("accepts a plain merge and rejects invalid ones", () => {
    expect(() => {
      validateMerge({ primary: free("a"), secondary: free("b"), secondaryHasMergedContacts: false });
    }).not.toThrow();
    const code = (input: Parameters<typeof validateMerge>[0]): string | undefined => {
      try {
        validateMerge(input);
      } catch (error) {
        return error instanceof ContactMergeError ? error.code : "other";
      }
      return undefined;
    };
    expect(code({ primary: free("a"), secondary: free("a"), secondaryHasMergedContacts: false })).toBe("same_contact");
    expect(code({ primary: undefined, secondary: free("a"), secondaryHasMergedContacts: false })).toBe("unknown_contact");
    expect(code({ primary: { ...free("a"), mergedIntoContactId: "z" }, secondary: free("b"), secondaryHasMergedContacts: false })).toBe("primary_is_merged");
    expect(code({ primary: free("a"), secondary: { ...free("b"), mergedIntoContactId: "z" }, secondaryHasMergedContacts: false })).toBe("secondary_already_merged");
    expect(code({ primary: free("a"), secondary: free("b"), secondaryHasMergedContacts: true })).toBe("secondary_has_merged_contacts");
    expect(code({ primary: free("a"), secondary: free("b", true), secondaryHasMergedContacts: false })).toBe("self_contact_cannot_be_secondary");
  });

  it("resolves effective ids and tolerates cycles", () => {
    expect(effectiveContactId("b", new Map([["b", "a"]]))).toBe("a");
    expect(effectiveContactId("x", new Map())).toBe("x");
    expect(effectiveContactId("a", new Map([["a", "b"], ["b", "a"]]))).toBeTypeOf("string");
  });
});
