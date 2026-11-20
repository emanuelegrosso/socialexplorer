import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_SUBDIRECTORIES,
  ensureAppPaths,
  isPathInside,
  resolveAppPaths,
  resolveWithin,
} from "./paths.js";

describe("app paths", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("derives every location under <userData>/SocialExplorer", () => {
    const base = resolve("/tmp/user-data");
    const paths = resolveAppPaths(base);
    expect(paths.root).toBe(join(base, "SocialExplorer"));
    expect(paths.databaseFile).toBe(join(base, "SocialExplorer", "database", "explorer.sqlite"));
    expect(paths.connectorAuth).toBe(join(base, "SocialExplorer", "connector-auth"));
    expect(
      (Object.values(paths) as string[]).every(
        (p) => p === paths.root || isPathInside(paths.root, p),
      ),
    ).toBe(true);
    expect(isPathInside(paths.database, paths.connectorAuth)).toBe(false);
  });

  it("rejects relative or malformed base directories", () => {
    expect(() => resolveAppPaths("relative/dir")).toThrow("user_data_dir_must_be_absolute");
    expect(() => resolveAppPaths("/tmp/a\0b")).toThrow();
  });

  it("creates all eight subdirectories idempotently", () => {
    const base = mkdtempSync(join(tmpdir(), "se-paths-"));
    dirs.push(base);
    const paths = resolveAppPaths(base);
    ensureAppPaths(paths);
    ensureAppPaths(paths);
    expect(APP_SUBDIRECTORIES).toHaveLength(8);
    for (const name of APP_SUBDIRECTORIES) {
      const directory = join(paths.root, name);
      expect(statSync(directory).isDirectory(), name).toBe(true);
    }
    expect(existsSync(paths.databaseFile)).toBe(false);
  });

  it("validates child paths against traversal", () => {
    const root = resolve("/tmp/root");
    expect(resolveWithin(root, "media", "a.jpg")).toBe(join(root, "media", "a.jpg"));
    expect(resolveWithin(root)).toBe(root);
    expect(() => resolveWithin(root, "..", "etc")).toThrow("path_escapes_root");
    expect(() => resolveWithin(root, "media/../../x")).toThrow("path_escapes_root");
    expect(() => resolveWithin(root, "/etc/passwd")).toThrow("path_segment_invalid");
    expect(() => resolveWithin(root, "a\0b")).toThrow("path_segment_invalid");
    expect(isPathInside(root, `${root}-sibling`)).toBe(false);
  });
});
