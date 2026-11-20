import type { CatalogMediaType, ContactSummary, MediaCatalogEntry } from "@social-explorer/contracts";

export interface MemoriesFilterState {
  readonly contactId: string | null;
  readonly conversationId: string | null;
  readonly mediaType: CatalogMediaType | null;
  readonly bookmarksOnly: boolean;
}

export const DEFAULT_MEMORIES_FILTERS: MemoriesFilterState = {
  contactId: null,
  conversationId: null,
  mediaType: null,
  bookmarksOnly: false,
};

export function applyMemoriesFilters(
  entries: readonly MediaCatalogEntry[],
  filters: MemoriesFilterState,
  bookmarkedMediaIds: ReadonlySet<string>,
): MediaCatalogEntry[] {
  return entries.filter((entry) => {
    if (filters.mediaType !== null && entry.mediaType !== filters.mediaType) {
      return false;
    }
    if (filters.conversationId !== null && entry.reference.conversationId !== filters.conversationId) {
      return false;
    }
    if (
      filters.contactId !== null &&
      entry.message?.senderContactId !== undefined &&
      entry.message.senderContactId !== filters.contactId
    ) {
      return false;
    }
    if (filters.bookmarksOnly && !bookmarkedMediaIds.has(entry.reference.id)) {
      return false;
    }
    return true;
  });
}

export function contactLabel(contacts: readonly ContactSummary[], contactId: string | null): string {
  if (contactId === null) {
    return "All people";
  }
  return contacts.find((contact) => contact.id === contactId)?.displayName ?? contactId;
}