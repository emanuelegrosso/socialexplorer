import type {
  Annotation,
  CatalogMediaType,
  ContactSummary,
  MediaCatalogEntry,
  MemoryCard,
  OnThisDayResult,
} from "@social-explorer/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RendererIpcClient } from "../../ipc-client";
import type { ViewId } from "../../store";
import { DEFAULT_MEMORIES_FILTERS, applyMemoriesFilters, contactLabel } from "./filters";
import { summarizeOnThisDay } from "./on-this-day";

const MEDIA_TYPES: readonly CatalogMediaType[] = ["photo", "video", "audio", "voice-note", "document"];

export function MemoriesPage(props: {
  readonly client: RendererIpcClient;
  readonly datasetId: string;
  readonly onNavigate: (view: ViewId, messageId?: string) => void;
}) {
  const [catalog, setCatalog] = useState<MediaCatalogEntry[]>([]);
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const [bookmarks, setBookmarks] = useState<Annotation[]>([]);
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [onThisDay, setOnThisDay] = useState<OnThisDayResult | null>(null);
  const [filters, setFilters] = useState(DEFAULT_MEMORIES_FILTERS);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const bookmarkedMedia = useMemo(
    () => new Set(bookmarks.filter((row) => row.targetKind === "media").map((row) => row.targetId)),
    [bookmarks],
  );

  const visible = useMemo(
    () => applyMemoriesFilters(catalog, filters, bookmarkedMedia),
    [bookmarkedMedia, catalog, filters],
  );

  const load = useCallback((): void => {
    setError(null);
    void Promise.all([
      props.client.api.queryMediaCatalog({ datasetId: props.datasetId, limit: 500 }),
      props.client.api.listContacts({ datasetId: props.datasetId }),
      props.client.api.listBookmarks({ datasetId: props.datasetId }),
      props.client.api.listMemoryCards({ datasetId: props.datasetId }),
      props.client.api.getOnThisDay({ datasetId: props.datasetId }),
    ])
      .then(([media, listedContacts, listedBookmarks, listedCards, day]) => {
        setCatalog(media);
        setContacts(listedContacts);
        setBookmarks(listedBookmarks);
        setCards(listedCards);
        setOnThisDay(day);
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Failed to load memories.");
      });
  }, [props.client.api, props.datasetId]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleBookmark = (reference: MediaCatalogEntry["reference"]): void => {
    const bookmarked = !bookmarkedMedia.has(reference.id);
    void props.client.api
      .toggleBookmark({
        datasetId: props.datasetId,
        targetKind: "media",
        targetId: reference.id,
        bookmarked,
      })
      .then(() => {
        load();
      });
  };

  const togglePick = (id: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const saveCard = (): void => {
    if (selectedIds.size === 0) {
      return;
    }
    const now = new Date().toISOString();
    const items = [...selectedIds].map((targetId) => {
      const entry = catalog.find((row) => row.reference.id === targetId);
      return {
        kind: "media" as const,
        targetId,
        ...(entry?.message?.text === undefined ? {} : { caption: entry.message.text.slice(0, 120) }),
      };
    });
    const cardId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? `mc_${crypto.randomUUID()}`
        : `mc_${String(Date.now())}`;
    void props.client.api
      .saveMemoryCard({
        id: cardId,
        datasetId: props.datasetId,
        title: `Memory card ${now.slice(0, 10)}`,
        items,
        createdAt: now,
        updatedAt: now,
      })
      .then(() => {
        setSelectedIds(new Set());
        load();
      });
  };

  const openSource = (entry: MediaCatalogEntry): void => {
    const messageId = entry.reference.messageId ?? entry.message?.id;
    if (messageId !== undefined) {
      props.onNavigate("timeline", messageId);
    }
  };

  return (
    <div className="memories-page">
      <header>
        <h2>Memories</h2>
        <p className="muted">Gallery, On This Day, bookmarks, and memory cards — synthetic media only in demo.</p>
      </header>
      {error !== null ? <p className="error">{error}</p> : null}

      <section className="card on-this-day" aria-label="On This Day">
        <h3>On This Day</h3>
        {onThisDay === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <>
            <p>
              {onThisDay.monthDay} ({onThisDay.timezone}) — {summarizeOnThisDay(onThisDay)}
            </p>
            {onThisDay.coverageNote !== undefined ? <p className="muted">{onThisDay.coverageNote}</p> : null}
            <ul className="plain-list on-this-day-list">
              {onThisDay.media.slice(0, 6).map((entry) => (
                <li key={entry.reference.id}>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => {
                      openSource(entry);
                    }}
                  >
                    {entry.mediaType ?? "media"} · {entry.reference.timestampLocal}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="memories-filters card" aria-label="Filters">
        <label>
          Person
          <select
            value={filters.contactId ?? ""}
            onChange={(event) => {
              setFilters((state) => ({
                ...state,
                contactId: event.target.value === "" ? null : event.target.value,
              }));
            }}
          >
            <option value="">{contactLabel(contacts, null)}</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Media type
          <select
            value={filters.mediaType ?? ""}
            onChange={(event) => {
              setFilters((state) => ({
                ...state,
                mediaType:
                  event.target.value === "" ? null : (event.target.value as CatalogMediaType),
              }));
            }}
          >
            <option value="">All types</option>
            {MEDIA_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.bookmarksOnly}
            onChange={(event) => {
              setFilters((state) => ({ ...state, bookmarksOnly: event.target.checked }));
            }}
          />
          Bookmarks only
        </label>
        <button type="button" className="ghost" disabled={selectedIds.size === 0} onClick={saveCard}>
          Save memory card ({selectedIds.size})
        </button>
      </section>

      <section className="media-gallery" aria-label="Media gallery">
        {visible.length === 0 ? (
          <p className="muted">No media matches these filters.</p>
        ) : (
          <ul className="gallery-grid">
            {visible.map((entry) => {
              const bookmarked = bookmarkedMedia.has(entry.reference.id);
              const picked = selectedIds.has(entry.reference.id);
              return (
                <li key={entry.reference.id} className="gallery-tile" data-availability={entry.reference.availability}>
                  <div className="tile-head">
                    <span>{entry.mediaType ?? entry.message?.kind ?? "media"}</span>
                    <span className="muted">{entry.reference.availability}</span>
                  </div>
                  <p className="tile-time">{entry.reference.timestampLocal}</p>
                  {entry.message?.text !== undefined ? <p className="tile-caption">{entry.message.text}</p> : null}
                  <div className="tile-actions">
                    <button
                      type="button"
                      onClick={() => {
                        toggleBookmark(entry.reference);
                      }}
                    >
                      {bookmarked ? "Unbookmark" : "Bookmark"}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        openSource(entry);
                      }}
                    >
                      Source message
                    </button>
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={picked}
                        onChange={() => {
                          togglePick(entry.reference.id);
                        }}
                      />
                      Card
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card memory-cards" aria-label="Memory cards">
        <h3>Memory cards</h3>
        {cards.length === 0 ? (
          <p className="muted">Select gallery items and save a card to revisit a moment.</p>
        ) : (
          <ul className="plain-list">
            {cards.map((card) => (
              <li key={card.id}>
                <strong>{card.title}</strong> · {card.items.length} items
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card bookmarks" aria-label="Bookmarks">
        <h3>Bookmarks</h3>
        <ul className="plain-list">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id}>
              {bookmark.targetKind} · {bookmark.targetId}
            </li>
          ))}
          {bookmarks.length === 0 ? <li className="muted">No bookmarks yet.</li> : null}
        </ul>
      </section>
    </div>
  );
}