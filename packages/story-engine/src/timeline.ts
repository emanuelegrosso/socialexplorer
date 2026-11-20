import type { SoundtrackTrack, StoryChapterItem, StoryProject } from "@social-explorer/contracts";
import type { ChapterTransition } from "./draft.js";
import type { MovieProject } from "./project.js";

export type TimelineEntryKind = "chapter-title" | StoryChapterItem["itemKind"];

export interface TimelineEntry {
  readonly id: string;
  readonly chapterId: string;
  readonly itemId?: string;
  readonly kind: TimelineEntryKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly transitionIn: ChapterTransition;
  readonly mediaAssetId?: string;
  readonly messageId?: string;
  /** User-authored label or title text only; raw message text never enters the timeline. */
  readonly label?: string;
  readonly stat?: { readonly label: string; readonly value: string | number };
  readonly contactId?: string;
  readonly includeMessageText: boolean;
  readonly includeContactName: boolean;
}

export interface PreviewTimeline {
  readonly projectId: string;
  readonly title: string;
  readonly aspectRatio: StoryProject["aspectRatio"];
  readonly totalDurationMs: number;
  readonly entries: readonly TimelineEntry[];
  readonly soundtrack: readonly SoundtrackTrack[];
}

const MIN_ITEM_SECONDS = 0.5;

/**
 * Structured preview timeline derived from the saved project. Chapter duration is shared
 * evenly between items without an explicit duration; empty chapters show a title card.
 * Message text and contact names are opt-in flags (default false, project then item level).
 */
export function buildPreviewTimeline(movie: MovieProject): PreviewTimeline {
  const entries: TimelineEntry[] = [];
  let cursorMs = 0;
  const { privacy } = movie.extras;
  for (const { chapter, items } of movie.chapters) {
    const chapterMs = Math.round(chapter.durationSeconds * 1000);
    if (items.length === 0) {
      entries.push({
        id: `${chapter.id}:title`,
        chapterId: chapter.id,
        kind: "chapter-title",
        startMs: cursorMs,
        endMs: cursorMs + chapterMs,
        transitionIn: chapter.transition,
        label: chapter.title,
        includeMessageText: false,
        includeContactName: false,
      });
      cursorMs += chapterMs;
      continue;
    }
    const explicit = items.map((item) => movie.extras.items[item.id]?.durationSeconds);
    const explicitMs = explicit.reduce<number>((sum, value) => sum + Math.round((value ?? 0) * 1000), 0);
    const flexible = explicit.filter((value) => value === undefined).length;
    const shareMs =
      flexible === 0
        ? 0
        : Math.max(
            MIN_ITEM_SECONDS * 1000,
            Math.round(Math.max(0, chapterMs - explicitMs) / flexible),
          );
    items.forEach((item, index) => {
      const extra = movie.extras.items[item.id];
      const durationMs = Math.round((extra?.durationSeconds ?? 0) * 1000) || shareMs;
      const base = {
        id: item.id,
        chapterId: chapter.id,
        itemId: item.id,
        kind: item.itemKind,
        startMs: cursorMs,
        endMs: cursorMs + durationMs,
        transitionIn: index === 0 ? chapter.transition : ("cut" as const),
        includeMessageText: extra?.includeMessageText ?? privacy.includeMessageText,
        includeContactName: extra?.includeContactName ?? privacy.includeContactNames,
      };
      entries.push({
        ...base,
        ...(item.mediaAssetId === undefined ? {} : { mediaAssetId: item.mediaAssetId }),
        ...(item.messageId === undefined ? {} : { messageId: item.messageId }),
        ...(extra?.label === undefined ? {} : { label: extra.label }),
        ...(extra?.stat === undefined ? {} : { stat: extra.stat }),
        ...(extra?.contactId === undefined ? {} : { contactId: extra.contactId }),
      });
      cursorMs += durationMs;
    });
  }
  return {
    projectId: movie.project.id,
    title: movie.project.title,
    aspectRatio: movie.project.aspectRatio,
    totalDurationMs: cursorMs,
    entries,
    soundtrack: movie.tracks,
  };
}
