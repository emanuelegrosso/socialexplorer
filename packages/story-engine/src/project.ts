import { randomUUID } from "node:crypto";
import type {
  MovieExport,
  SoundtrackTrack,
  StoryChapter,
  StoryChapterItem,
  StoryProject,
} from "@social-explorer/contracts";
import {
  createMediaStorytellingRepository,
  createSettingsRepository,
  runInTransaction,
  type MediaStorytellingRepository,
  type SqliteDatabase,
} from "@social-explorer/database";
import type { ChapterDraft, ChapterDraftEdit } from "./draft.js";
import type { ChapterRationale } from "./suggestions.js";

export type AspectRatio = StoryProject["aspectRatio"];
export const ASPECT_RATIOS: readonly AspectRatio[] = ["16:9", "9:16", "1:1"];
export const DEFAULT_ASPECT_RATIO: AspectRatio = "16:9";

export interface PersonSelection {
  readonly kind: "contact" | "group";
  readonly id: string;
}

export interface ItemExtras {
  readonly label?: string;
  readonly stat?: { readonly label: string; readonly value: string | number };
  readonly durationSeconds?: number;
  readonly contactId?: string;
  /** Opt-in per item; unset falls back to the project-level privacy setting. */
  readonly includeMessageText?: boolean;
  readonly includeContactName?: boolean;
}

export interface StudioExtras {
  readonly people: readonly PersonSelection[];
  readonly items: Readonly<Record<string, ItemExtras>>;
  readonly rationales: Readonly<Record<string, ChapterRationale>>;
  readonly privacy: { readonly includeMessageText: boolean; readonly includeContactNames: boolean };
}

export interface ChapterWithItems {
  readonly chapter: StoryChapter;
  readonly items: readonly StoryChapterItem[];
}

export interface MovieProject {
  readonly project: StoryProject;
  readonly chapters: readonly ChapterWithItems[];
  readonly tracks: readonly SoundtrackTrack[];
  readonly exports: readonly MovieExport[];
  readonly extras: StudioExtras;
}

export interface CreateProjectInput {
  readonly datasetId: string;
  readonly title: string;
  readonly dateRangeStart?: string;
  readonly dateRangeEnd?: string;
  readonly aspectRatio?: AspectRatio;
}

export interface ProjectSettingsEdit {
  readonly title?: string;
  readonly dateRangeStart?: string | null;
  readonly dateRangeEnd?: string | null;
  readonly aspectRatio?: AspectRatio;
}

export interface NewItemInput {
  readonly itemKind: StoryChapterItem["itemKind"];
  readonly mediaAssetId?: string;
  readonly messageId?: string;
  readonly extras?: ItemExtras;
}

export interface MovieStudioClock {
  readonly now: () => string;
  readonly newId: () => string;
}

const defaultClock: MovieStudioClock = {
  now: () => new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  newId: () => randomUUID(),
};

const EMPTY_EXTRAS: StudioExtras = {
  people: [],
  items: {},
  rationales: {},
  privacy: { includeMessageText: false, includeContactNames: false },
};

const extrasKey = (projectId: string): string => `movie-studio:${projectId}`;

export class MovieStudioError extends Error {
  override readonly name = "MovieStudioError";
}

function requireTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) throw new MovieStudioError("Title must not be empty");
  return trimmed;
}

function checkRange(start: string | undefined | null, end: string | undefined | null): void {
  if (start != null && end != null && Date.parse(start) > Date.parse(end)) {
    throw new MovieStudioError("Date range start must not be after its end");
  }
}

function checkItem(input: NewItemInput): void {
  const needsMedia = input.itemKind === "photo" || input.itemKind === "video" || input.itemKind === "audio";
  if (needsMedia && input.mediaAssetId === undefined) {
    throw new MovieStudioError(`${input.itemKind} items need a media asset`);
  }
  if (input.itemKind === "message-card" && input.messageId === undefined) {
    throw new MovieStudioError("message-card items need a message");
  }
  if (input.extras?.durationSeconds !== undefined && !(input.extras.durationSeconds > 0)) {
    throw new MovieStudioError("Item duration must be positive");
  }
}

/**
 * Persistent Guided Movie Studio project manager (WX-087). Projects, chapters, clips (chapter
 * items), soundtrack tracks and export jobs live in the media-storytelling tables; the few
 * studio-only choices without a column (people/groups, card payloads, privacy opt-ins,
 * suggestion rationales) are kept as JSON in app settings. Everything is explicit user input:
 * nothing is generated, published or finalized automatically.
 */
export class MovieStudioManager {
  readonly #db: SqliteDatabase;
  readonly #repo: MediaStorytellingRepository;
  readonly #settings: ReturnType<typeof createSettingsRepository>;
  readonly #clock: MovieStudioClock;

  constructor(db: SqliteDatabase, clock: Partial<MovieStudioClock> = {}) {
    this.#db = db;
    this.#repo = createMediaStorytellingRepository(db);
    this.#settings = createSettingsRepository(db);
    this.#clock = { ...defaultClock, ...clock };
  }

  createProject(input: CreateProjectInput): MovieProject {
    checkRange(input.dateRangeStart, input.dateRangeEnd);
    const now = this.#clock.now();
    const aspectRatio = input.aspectRatio ?? DEFAULT_ASPECT_RATIO;
    if (!ASPECT_RATIOS.includes(aspectRatio)) throw new MovieStudioError("Unsupported aspect ratio");
    const project: StoryProject = {
      id: this.#clock.newId(),
      datasetId: input.datasetId,
      title: requireTitle(input.title),
      ...(input.dateRangeStart === undefined ? {} : { dateRangeStart: input.dateRangeStart }),
      ...(input.dateRangeEnd === undefined ? {} : { dateRangeEnd: input.dateRangeEnd }),
      status: "draft",
      aspectRatio,
      createdAt: now,
      updatedAt: now,
    };
    this.#repo.upsertProject(project);
    this.#saveExtras(project.id, EMPTY_EXTRAS);
    return this.#require(project.id);
  }

  listProjects(datasetId: string): StoryProject[] {
    return this.#repo.listProjects(datasetId);
  }

  /** Load for resume: reflects exactly what was last saved, across restarts. */
  load(projectId: string): MovieProject | undefined {
    const project = this.#repo.getProject(projectId);
    if (project === undefined) return undefined;
    return {
      project,
      chapters: this.#repo.listChapters(projectId).map((chapter) => ({
        chapter,
        items: this.#repo.listChapterItems(chapter.id),
      })),
      tracks: this.#repo.listSoundtrackTracks(projectId),
      exports: this.#repo.listMovieExports(projectId),
      extras: this.#loadExtras(projectId),
    };
  }

  deleteProject(projectId: string): void {
    runInTransaction(this.#db, () => {
      this.#repo.deleteProject(projectId);
      this.#settings.delete(extrasKey(projectId));
    });
  }

  updateSettings(projectId: string, edit: ProjectSettingsEdit): MovieProject {
    const current = this.#require(projectId).project;
    const start = edit.dateRangeStart === undefined ? current.dateRangeStart : edit.dateRangeStart;
    const end = edit.dateRangeEnd === undefined ? current.dateRangeEnd : edit.dateRangeEnd;
    checkRange(start, end);
    const aspectRatio = edit.aspectRatio ?? current.aspectRatio;
    if (!ASPECT_RATIOS.includes(aspectRatio)) throw new MovieStudioError("Unsupported aspect ratio");
    this.#repo.upsertProject({
      id: current.id,
      datasetId: current.datasetId,
      title: edit.title === undefined ? current.title : requireTitle(edit.title),
      ...(start == null ? {} : { dateRangeStart: start }),
      ...(end == null ? {} : { dateRangeEnd: end }),
      status: current.status,
      aspectRatio,
      createdAt: current.createdAt,
      updatedAt: this.#clock.now(),
    });
    return this.#require(projectId);
  }

  setPeople(projectId: string, people: readonly PersonSelection[]): MovieProject {
    return this.#updateExtras(projectId, (extras) => ({ ...extras, people }));
  }

  setPrivacy(
    projectId: string,
    privacy: Partial<StudioExtras["privacy"]>,
  ): MovieProject {
    return this.#updateExtras(projectId, (extras) => ({
      ...extras,
      privacy: { ...extras.privacy, ...privacy },
    }));
  }

  addChapter(projectId: string, draft: Omit<ChapterDraft, "id"> & { id?: string }): MovieProject {
    this.#require(projectId);
    const id = draft.id ?? this.#clock.newId();
    const sortOrder = this.#repo.listChapters(projectId).length;
    runInTransaction(this.#db, () => {
      this.#repo.upsertChapter(this.#toChapter(projectId, { ...draft, id }, sortOrder));
      this.#touch(projectId);
    });
    if (draft.rationale !== undefined) {
      const rationale = draft.rationale;
      this.#updateExtras(projectId, (extras) => ({
        ...extras,
        rationales: { ...extras.rationales, [id]: rationale },
      }));
    }
    return this.#require(projectId);
  }

  /** Persist user-accepted drafts (e.g. edited suggestions) in the given order. */
  acceptDrafts(projectId: string, drafts: readonly ChapterDraft[]): MovieProject {
    for (const draft of drafts) this.addChapter(projectId, { ...draft, id: this.#clock.newId() });
    return this.#require(projectId);
  }

  editChapter(projectId: string, chapterId: string, edit: ChapterDraftEdit): MovieProject {
    const chapter = this.#chapter(projectId, chapterId);
    if (edit.title !== undefined) requireTitle(edit.title);
    if (edit.durationSeconds !== undefined && !(edit.durationSeconds > 0)) {
      throw new MovieStudioError("Chapter duration must be positive");
    }
    this.#repo.upsertChapter({
      ...chapter,
      ...(edit.title === undefined ? {} : { title: edit.title.trim() }),
      ...(edit.narrativeText === undefined ? {} : { narrativeText: edit.narrativeText }),
      ...(edit.startAt === undefined ? {} : { startAt: edit.startAt }),
      ...(edit.endAt === undefined ? {} : { endAt: edit.endAt }),
      ...(edit.transition === undefined ? {} : { transition: edit.transition }),
      ...(edit.durationSeconds === undefined ? {} : { durationSeconds: edit.durationSeconds }),
    });
    this.#touch(projectId);
    return this.#require(projectId);
  }

  renameChapter(projectId: string, chapterId: string, title: string): MovieProject {
    return this.editChapter(projectId, chapterId, { title });
  }

  reorderChapters(projectId: string, orderedIds: readonly string[]): MovieProject {
    const chapters = this.#repo.listChapters(projectId);
    this.#checkPermutation(chapters.map((c) => c.id), orderedIds);
    runInTransaction(this.#db, () => {
      orderedIds.forEach((id, sortOrder) => {
        const chapter = chapters.find((c) => c.id === id);
        if (chapter === undefined) throw new MovieStudioError(`Unknown chapter ${id}`);
        this.#repo.upsertChapter({ ...chapter, sortOrder });
      });
      this.#touch(projectId);
    });
    return this.#require(projectId);
  }

  deleteChapter(projectId: string, chapterId: string): MovieProject {
    this.#chapter(projectId, chapterId);
    runInTransaction(this.#db, () => {
      this.#db.prepare("DELETE FROM story_chapters WHERE id = ?").run(chapterId);
      this.#repo.listChapters(projectId).forEach((chapter, sortOrder) => {
        this.#repo.upsertChapter({ ...chapter, sortOrder });
      });
      this.#touch(projectId);
    });
    this.#updateExtras(projectId, (extras) => ({
      ...extras,
      rationales: Object.fromEntries(
        Object.entries(extras.rationales).filter(([key]) => key !== chapterId),
      ),
    }));
    return this.#require(projectId);
  }

  addItem(projectId: string, chapterId: string, input: NewItemInput): MovieProject {
    this.#chapter(projectId, chapterId);
    checkItem(input);
    const id = this.#clock.newId();
    const sortOrder = this.#repo.listChapterItems(chapterId).length;
    this.#repo.upsertChapterItem({
      id,
      chapterId,
      itemKind: input.itemKind,
      ...(input.mediaAssetId === undefined ? {} : { mediaAssetId: input.mediaAssetId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      sortOrder,
    });
    this.#touch(projectId);
    if (input.extras !== undefined) {
      const extras = input.extras;
      this.#updateExtras(projectId, (current) => ({
        ...current,
        items: { ...current.items, [id]: extras },
      }));
    }
    return this.#require(projectId);
  }

  updateItemExtras(projectId: string, itemId: string, extras: ItemExtras): MovieProject {
    if (extras.durationSeconds !== undefined && !(extras.durationSeconds > 0)) {
      throw new MovieStudioError("Item duration must be positive");
    }
    return this.#updateExtras(projectId, (current) => ({
      ...current,
      items: { ...current.items, [itemId]: { ...current.items[itemId], ...extras } },
    }));
  }

  reorderItems(projectId: string, chapterId: string, orderedIds: readonly string[]): MovieProject {
    this.#chapter(projectId, chapterId);
    const items = this.#repo.listChapterItems(chapterId);
    this.#checkPermutation(items.map((i) => i.id), orderedIds);
    runInTransaction(this.#db, () => {
      orderedIds.forEach((id, sortOrder) => {
        const item = items.find((i) => i.id === id);
        if (item === undefined) throw new MovieStudioError(`Unknown item ${id}`);
        this.#repo.upsertChapterItem({ ...item, sortOrder });
      });
      this.#touch(projectId);
    });
    return this.#require(projectId);
  }

  removeItem(projectId: string, itemId: string): MovieProject {
    this.#db.prepare("DELETE FROM story_chapter_items WHERE id = ?").run(itemId);
    this.#touch(projectId);
    return this.#updateExtras(projectId, (extras) => ({
      ...extras,
      items: Object.fromEntries(Object.entries(extras.items).filter(([key]) => key !== itemId)),
    }));
  }

  /** Low-level access shared with the composer package (tracks, export jobs). */
  get repository(): MediaStorytellingRepository {
    return this.#repo;
  }

  #toChapter(
    projectId: string,
    draft: Omit<ChapterDraft, "id"> & { id: string },
    sortOrder: number,
  ): StoryChapter {
    return {
      id: draft.id,
      projectId,
      title: requireTitle(draft.title),
      ...(draft.narrativeText === undefined ? {} : { narrativeText: draft.narrativeText }),
      ...(draft.startAt === undefined ? {} : { startAt: draft.startAt }),
      ...(draft.endAt === undefined ? {} : { endAt: draft.endAt }),
      sortOrder,
      transition: draft.transition,
      durationSeconds: draft.durationSeconds,
    };
  }

  #checkPermutation(existing: readonly string[], ordered: readonly string[]): void {
    if (
      ordered.length !== existing.length ||
      new Set(ordered).size !== existing.length ||
      !existing.every((id) => ordered.includes(id))
    ) {
      throw new MovieStudioError("Reorder must list every entry exactly once");
    }
  }

  #require(projectId: string): MovieProject {
    const movie = this.load(projectId);
    if (movie === undefined) throw new MovieStudioError(`Unknown project ${projectId}`);
    return movie;
  }

  #chapter(projectId: string, chapterId: string): StoryChapter {
    const chapter = this.#repo.listChapters(projectId).find((c) => c.id === chapterId);
    if (chapter === undefined) throw new MovieStudioError(`Unknown chapter ${chapterId}`);
    return chapter;
  }

  #touch(projectId: string): void {
    const project = this.#repo.getProject(projectId);
    if (project !== undefined) {
      this.#repo.upsertProject({ ...project, updatedAt: this.#clock.now() });
    }
  }

  #loadExtras(projectId: string): StudioExtras {
    const raw = this.#settings.get(extrasKey(projectId)) as Partial<StudioExtras> | undefined;
    return {
      people: raw?.people ?? [],
      items: raw?.items ?? {},
      rationales: raw?.rationales ?? {},
      privacy: {
        includeMessageText: raw?.privacy?.includeMessageText ?? false,
        includeContactNames: raw?.privacy?.includeContactNames ?? false,
      },
    };
  }

  #saveExtras(projectId: string, extras: StudioExtras): void {
    this.#settings.set(extrasKey(projectId), extras, this.#clock.now());
  }

  #updateExtras(projectId: string, change: (extras: StudioExtras) => StudioExtras): MovieProject {
    this.#require(projectId);
    this.#saveExtras(projectId, change(this.#loadExtras(projectId)));
    this.#touch(projectId);
    return this.#require(projectId);
  }
}
