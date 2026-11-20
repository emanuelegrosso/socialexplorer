import type { Contact, ContactMerge, ContactSummary } from "@social-explorer/contracts";
import {
  ContactMergeError,
  matchIdentifiers,
  resolveIdentity,
  suggestMerges,
  validateMerge,
  type IdentifierMatch,
  type IdentityResolution,
  type KnownContact,
  type MergeSuggestion,
} from "@social-explorer/domain";
import { deterministicId } from "@social-explorer/shared";
import type { SqliteDatabase } from "./open.js";
import { createContactRepository } from "./repositories-core.js";
import { nn, stripUndefined } from "./util.js";

interface MergeRow {
  id: string;
  dataset_id: string;
  primary_contact_id: string;
  secondary_contact_id: string;
  merged_at: string;
  unmerged_at: string | null;
  reason: string | null;
}

interface SubjectRow {
  id: string;
  is_self: number;
  merged_into_contact_id: string | null;
}

export interface MergeOptions {
  readonly now?: string;
  readonly reason?: string;
}

export function createIdentityRepository(db: SqliteDatabase) {
  const contacts = createContactRepository(db);
  const subject = db.prepare(
    "SELECT id, is_self, merged_into_contact_id FROM contacts WHERE id = ? AND dataset_id = ?",
  );
  const childCount = db.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE merged_into_contact_id = ?",
  );
  const setMergedInto = db.prepare("UPDATE contacts SET merged_into_contact_id = ? WHERE id = ?");
  const insertMerge = db.prepare(`
    INSERT INTO contact_merges (id, dataset_id, primary_contact_id, secondary_contact_id, merged_at, reason)
    VALUES (@id, @datasetId, @primaryContactId, @secondaryContactId, @mergedAt, @reason)`);
  const openMerge = db.prepare(
    "SELECT * FROM contact_merges WHERE dataset_id = ? AND secondary_contact_id = ? AND unmerged_at IS NULL",
  );
  const closeMerge = db.prepare("UPDATE contact_merges SET unmerged_at = ? WHERE id = ?");
  const listMergeRows = db.prepare(
    "SELECT * FROM contact_merges WHERE dataset_id = ? ORDER BY merged_at, id",
  );
  const mergedChildren = db.prepare(
    "SELECT id FROM contacts WHERE dataset_id = ? AND merged_into_contact_id = ? ORDER BY id",
  );
  const mergeMap = db.prepare(
    "SELECT id, merged_into_contact_id AS target FROM contacts WHERE dataset_id = ? AND merged_into_contact_id IS NOT NULL",
  );

  const mapMerge = (row: MergeRow): ContactMerge =>
    stripUndefined({
      id: row.id,
      datasetId: row.dataset_id,
      primaryContactId: row.primary_contact_id,
      secondaryContactId: row.secondary_contact_id,
      mergedAt: row.merged_at,
      unmergedAt: nn(row.unmerged_at),
      reason: nn(row.reason),
    });

  const toSubject = (row: SubjectRow | undefined) =>
    row === undefined
      ? undefined
      : {
          id: row.id,
          isSelf: row.is_self === 1,
          mergedIntoContactId: row.merged_into_contact_id,
        };

  const readMergeMap = (datasetId: string): Map<string, string> => {
    const rows = mergeMap.all(datasetId) as { id: string; target: string }[];
    return new Map(rows.map((row) => [row.id, row.target]));
  };

  const known = (datasetId: string): KnownContact[] => {
    const merged = readMergeMap(datasetId);
    return contacts.listByDataset(datasetId).map((contact) => ({
      id: contact.id,
      displayName: contact.displayName,
      identifiers: contact.identifiers,
      mergedIntoContactId: merged.get(contact.id) ?? null,
    }));
  };

  return {
    /** Map of merged secondary id -> primary id, for read-time sender resolution. */
    mergeMap: readMergeMap,

    /**
     * Explicit manual merge. Messages, identifiers and provenance of the secondary are left
     * untouched; the secondary is only redirected to the primary at read time.
     */
    mergeContacts(
      datasetId: string,
      primaryContactId: string,
      secondaryContactId: string,
      options: MergeOptions = {},
    ): ContactMerge {
      return db.transaction(() => {
        validateMerge({
          primary: toSubject(subject.get(primaryContactId, datasetId) as SubjectRow | undefined),
          secondary: toSubject(
            subject.get(secondaryContactId, datasetId) as SubjectRow | undefined,
          ),
          secondaryHasMergedContacts:
            (childCount.get(secondaryContactId) as { n: number }).n > 0,
        });
        const mergedAt = options.now ?? new Date().toISOString();
        const id = deterministicId("merge", [datasetId, primaryContactId, secondaryContactId, mergedAt]);
        insertMerge.run({
          id,
          datasetId,
          primaryContactId,
          secondaryContactId,
          mergedAt,
          reason: options.reason ?? null,
        });
        setMergedInto.run(primaryContactId, secondaryContactId);
        return mapMerge({
          id,
          dataset_id: datasetId,
          primary_contact_id: primaryContactId,
          secondary_contact_id: secondaryContactId,
          merged_at: mergedAt,
          unmerged_at: null,
          reason: options.reason ?? null,
        });
      })();
    },

    /** Restores the secondary as an independent contact; the merge record is kept as history. */
    unmergeContact(datasetId: string, secondaryContactId: string, now?: string): ContactMerge {
      return db.transaction(() => {
        const row = openMerge.get(datasetId, secondaryContactId) as MergeRow | undefined;
        if (row === undefined) {
          throw new ContactMergeError("unknown_contact", "contact is not currently merged");
        }
        const unmergedAt = now ?? new Date().toISOString();
        closeMerge.run(unmergedAt, row.id);
        setMergedInto.run(null, secondaryContactId);
        return mapMerge({ ...row, unmerged_at: unmergedAt });
      })();
    },

    listMerges(datasetId: string): ContactMerge[] {
      return (listMergeRows.all(datasetId) as MergeRow[]).map(mapMerge);
    },

    /** Active (non-merged) contacts; each carries the identifiers/aliases of contacts merged into it. */
    listActiveContacts(datasetId: string): ContactSummary[] {
      const all = contacts.listByDataset(datasetId);
      const byId = new Map(all.map((contact) => [contact.id, contact]));
      const map = readMergeMap(datasetId);
      const out: ContactSummary[] = [];
      for (const contact of all) {
        if (map.has(contact.id)) {
          continue;
        }
        const children = (mergedChildren.all(datasetId, contact.id) as { id: string }[]).flatMap(
          ({ id }) => {
            const child = byId.get(id);
            return child === undefined ? [] : [child];
          },
        );
        const identifiers = new Map<string, Contact["identifiers"][number]>();
        for (const source of [contact, ...children]) {
          for (const identifier of source.identifiers) {
            identifiers.set(`${identifier.type}\u001f${identifier.value}`, identifier);
          }
        }
        const aliases = new Set(contact.aliases);
        for (const child of children) {
          aliases.add(child.displayName);
          for (const alias of child.aliases) {
            aliases.add(alias);
          }
        }
        aliases.delete(contact.displayName);
        out.push({
          ...contact,
          aliases: [...aliases].sort(),
          identifiers: [...identifiers.values()],
          mergedContactIds: children.map((child) => child.id),
        });
      }
      return out;
    },

    matchIdentifiers(
      datasetId: string,
      incoming: Parameters<typeof matchIdentifiers>[0],
    ): IdentifierMatch[] {
      return matchIdentifiers(incoming, known(datasetId));
    },

    resolveIdentity(
      datasetId: string,
      incoming: Parameters<typeof resolveIdentity>[0],
    ): IdentityResolution {
      return resolveIdentity(incoming, known(datasetId));
    },

    suggestMerges(datasetId: string): MergeSuggestion[] {
      return suggestMerges(known(datasetId));
    },
  };
}
