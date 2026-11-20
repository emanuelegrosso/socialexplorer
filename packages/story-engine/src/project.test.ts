import { describe, expect, it } from "vitest";
import { seedSynthetic } from "./seed.testutil.js";
import { buildPreviewTimeline, draftFromSuggestion, MovieStudioManager, suggestChapters, type MovieProject } from "./index.js";

function loadRequired(manager: MovieStudioManager, id: string): MovieProject {
  const movie = manager.load(id);
  if (movie === undefined) throw new Error(`Missing project ${id}`);
  return movie;
}

function firstChapterId(movie: MovieProject): string {
  const chapter = movie.chapters[0]?.chapter;
  if (chapter === undefined) throw new Error("Missing chapter");
  return chapter.id;
}

function setup() {
  const { db } = seedSynthetic();
  let n = 0;
  const manager = new MovieStudioManager(db, { newId: () => `id-${String(++n)}`, now: () => "2026-03-01T00:00:00Z" });
  return { db, manager };
}

describe("MovieStudioManager", () => {
  it("creates with 16:9 default and survives reload", () => {
    const { db, manager } = setup();
    const created = manager.createProject({ datasetId: "ds-1", title: "Synthetic Year" });
    expect(created.project.aspectRatio).toBe("16:9");
    expect(created.project.status).toBe("draft");
    manager.addChapter(created.project.id, { title: "One", transition: "fade", durationSeconds: 6, origin: "user" });
    const reopened = new MovieStudioManager(db).load(created.project.id);
    expect(reopened?.chapters.map((c) => c.chapter.title)).toEqual(["One"]);
  });

  it("validates settings and supports 9:16 / 1:1", () => {
    const { manager } = setup();
    const { project } = manager.createProject({ datasetId: "ds-1", title: "T", dateRangeStart: "2026-01-01T00:00:00Z", dateRangeEnd: "2026-02-01T00:00:00Z" });
    expect(manager.updateSettings(project.id, { aspectRatio: "9:16" }).project.aspectRatio).toBe("9:16");
    expect(manager.updateSettings(project.id, { aspectRatio: "1:1", title: "New" }).project.title).toBe("New");
    expect(() => manager.updateSettings(project.id, { dateRangeEnd: "2025-01-01T00:00:00Z" })).toThrow();
    expect(() => manager.updateSettings(project.id, { title: " " })).toThrow();
    expect(manager.updateSettings(project.id, { dateRangeEnd: null }).project.dateRangeEnd).toBeUndefined();
  });

  it("edits, reorders and deletes chapters persistently", () => {
    const { db, manager } = setup();
    const id = manager.createProject({ datasetId: "ds-1", title: "T" }).project.id;
    for (const title of ["A", "B", "C"]) manager.addChapter(id, { title, transition: "cut", durationSeconds: 4, origin: "user" });
    let movie = loadRequired(manager, id);
    const ids = movie.chapters.map((x) => x.chapter.id);
    if (ids.length !== 3 || ids[0] === undefined || ids[1] === undefined || ids[2] === undefined) {
      throw new Error("expected 3 chapters");
    }
    const [a, b, c] = ids;
    manager.reorderChapters(id, [c, a, b]);
    manager.renameChapter(id, a, "Alpha");
    manager.deleteChapter(id, b);
    movie = loadRequired(new MovieStudioManager(db), id);
    expect(movie.chapters.map((x) => [x.chapter.title, x.chapter.sortOrder])).toEqual([["C", 0], ["Alpha", 1]]);
    expect(() => manager.reorderChapters(id, [a])).toThrow();
  });

  it("accepts edited suggestions as new chapters with their rationale", () => {
    const { manager } = setup();
    const id = manager.createProject({ datasetId: "ds-1", title: "T" }).project.id;
    const events = Array.from({ length: 12 }, (_, i) => ({ id: `e${String(i)}`, conversationId: "c", timestampUtc: `2026-01-${String(i * 3 + 1).padStart(2, "0")}T10:00:00Z`, kind: "message" as const }));
    const suggestions = suggestChapters([...events, { id: "late", conversationId: "c", timestampUtc: "2026-03-20T10:00:00Z", kind: "message" }]);
    expect(manager.load(id)?.chapters).toHaveLength(0);
    const movie = manager.acceptDrafts(id, suggestions.map((s) => draftFromSuggestion(s)));
    expect(movie.chapters.length).toBe(suggestions.length);
    const first = firstChapterId(movie);
    expect(movie.extras.rationales[first]?.explanation).toBeTruthy();
  });

  it("manages items, extras and the preview timeline", () => {
    const { manager } = setup();
    const id = manager.createProject({ datasetId: "ds-1", title: "T" }).project.id;
    manager.addChapter(id, { title: "Ch1", transition: "crossfade", durationSeconds: 10, origin: "user" });
    manager.addChapter(id, { title: "Empty", transition: "fade", durationSeconds: 3, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, id));
    manager.addItem(id, ch, { itemKind: "title-card", extras: { label: "Hello", durationSeconds: 2 } });
    manager.addItem(id, ch, { itemKind: "stat-card", extras: { label: "Messages", stat: { label: "Messages", value: 42 } } });
    manager.addItem(id, ch, { itemKind: "message-card", messageId: "m-1" });
    expect(() => manager.addItem(id, ch, { itemKind: "photo" })).toThrow();
    const movie = manager.setPeople(id, [{ kind: "contact", id: "c-alice" }]);
    expect(movie.extras.people).toHaveLength(1);
    const timeline = buildPreviewTimeline(movie);
    expect(timeline.entries.map((e) => [e.kind, e.startMs, e.endMs])).toEqual([
      ["title-card", 0, 2000],
      ["stat-card", 2000, 6000],
      ["message-card", 6000, 10000],
      ["chapter-title", 10000, 13000],
    ]);
    expect(timeline.entries[0]?.transitionIn).toBe("crossfade");
    expect(timeline.entries[1]?.transitionIn).toBe("cut");
    expect(timeline.totalDurationMs).toBe(13000);
    expect(timeline.entries.every((e) => !e.includeMessageText && !e.includeContactName)).toBe(true);
  });

  it("applies privacy opt-ins at project then item level", () => {
    const { manager } = setup();
    const id = manager.createProject({ datasetId: "ds-1", title: "T" }).project.id;
    manager.addChapter(id, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, id));
    manager.addItem(id, ch, { itemKind: "message-card", messageId: "m-1" });
    manager.addItem(id, ch, { itemKind: "message-card", messageId: "m-2" });
    const secondItem = loadRequired(manager, id).chapters[0]?.items[1];
    if (secondItem === undefined) throw new Error("missing second item");
    manager.updateItemExtras(id, secondItem.id, { includeMessageText: true });
    const t = buildPreviewTimeline(loadRequired(manager, id));
    expect(t.entries.map((e) => e.includeMessageText)).toEqual([false, true]);
    const t2 = buildPreviewTimeline(manager.setPrivacy(id, { includeContactNames: true }));
    expect(t2.entries.every((e) => e.includeContactName)).toBe(true);
  });

  it("removes items and deletes projects with their extras", () => {
    const { manager } = setup();
    const id = manager.createProject({ datasetId: "ds-1", title: "T" }).project.id;
    manager.addChapter(id, { title: "Ch", transition: "cut", durationSeconds: 4, origin: "user" });
    const ch = firstChapterId(loadRequired(manager, id));
    manager.addItem(id, ch, { itemKind: "title-card" });
    manager.addItem(id, ch, { itemKind: "title-card" });
    const itemIds = loadRequired(manager, id).chapters[0]?.items.map((i) => i.id) ?? [];
    if (itemIds.length !== 2 || itemIds[0] === undefined || itemIds[1] === undefined) {
      throw new Error("expected two items");
    }
    const [i1, i2] = itemIds;
    manager.reorderItems(id, ch, [i2, i1]);
    expect(loadRequired(manager, id).chapters[0]?.items.map((i) => i.id)).toEqual([i2, i1]);
    expect(manager.removeItem(id, i1).chapters[0]?.items).toHaveLength(1);
    manager.deleteProject(id);
    expect(manager.load(id)).toBeUndefined();
    expect(manager.listProjects("ds-1")).toEqual([]);
  });
});
