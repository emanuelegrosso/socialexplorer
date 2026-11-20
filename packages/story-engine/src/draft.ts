import type { ChapterRationale, ChapterSuggestion } from "./suggestions.js";

export type ChapterTransition = "cut" | "fade" | "crossfade";

/**
 * A chapter the user is shaping. Drafts are created from suggestions only on request, and
 * every field stays editable; nothing here is finalized until the manager persists it.
 */
export interface ChapterDraft {
  readonly id: string;
  readonly title: string;
  readonly narrativeText?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly transition: ChapterTransition;
  readonly durationSeconds: number;
  readonly origin: "suggestion" | "user";
  readonly rationale?: ChapterRationale;
}

export interface ChapterDraftEdit {
  readonly title?: string;
  readonly narrativeText?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly transition?: ChapterTransition;
  readonly durationSeconds?: number;
}

export function draftFromSuggestion(
  suggestion: ChapterSuggestion,
  defaults: { transition?: ChapterTransition; durationSeconds?: number } = {},
): ChapterDraft {
  return {
    id: suggestion.id,
    title: suggestion.title,
    startAt: suggestion.startAt,
    endAt: suggestion.endAt,
    transition: defaults.transition ?? "fade",
    durationSeconds: defaults.durationSeconds ?? 8,
    origin: "suggestion",
    rationale: suggestion.rationale,
  };
}

export function renameDraft(
  drafts: readonly ChapterDraft[],
  id: string,
  title: string,
): ChapterDraft[] {
  return editDraft(drafts, id, { title });
}

export function editDraft(
  drafts: readonly ChapterDraft[],
  id: string,
  edit: ChapterDraftEdit,
): ChapterDraft[] {
  if (!drafts.some((draft) => draft.id === id)) throw new RangeError(`Unknown chapter draft ${id}`);
  if (edit.title !== undefined && edit.title.trim().length === 0) {
    throw new RangeError("Chapter title must not be empty");
  }
  if (edit.durationSeconds !== undefined && !(edit.durationSeconds > 0)) {
    throw new RangeError("Chapter duration must be positive");
  }
  return drafts.map((draft) => (draft.id === id ? { ...draft, ...edit } : draft));
}

export function reorderDrafts(
  drafts: readonly ChapterDraft[],
  orderedIds: readonly string[],
): ChapterDraft[] {
  if (
    orderedIds.length !== drafts.length ||
    new Set(orderedIds).size !== drafts.length ||
    !drafts.every((draft) => orderedIds.includes(draft.id))
  ) {
    throw new RangeError("Reorder must list every chapter exactly once");
  }
  return orderedIds.map((id) => drafts.find((draft) => draft.id === id) as ChapterDraft);
}

export function deleteDraft(drafts: readonly ChapterDraft[], id: string): ChapterDraft[] {
  return drafts.filter((draft) => draft.id !== id);
}
