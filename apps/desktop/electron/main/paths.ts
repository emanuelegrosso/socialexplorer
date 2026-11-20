import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const APP_DIRECTORY_NAME = "SocialExplorer" as const;
export const DATABASE_FILE_NAME = "explorer.sqlite" as const;

export const APP_SUBDIRECTORIES = [
  "database",
  "connector-auth",
  "logs",
  "exports",
  "backups",
  "settings",
  "media",
  "thumbnails",
] as const;

export type AppSubdirectory = (typeof APP_SUBDIRECTORIES)[number];

export interface AppPaths {
  readonly root: string;
  readonly database: string;
  readonly databaseFile: string;
  readonly connectorAuth: string;
  readonly logs: string;
  readonly exports: string;
  readonly backups: string;
  readonly settings: string;
  readonly media: string;
  readonly thumbnails: string;
}

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Resolves `segments` under `root`, rejecting traversal, absolute segments and NUL bytes. */
export function resolveWithin(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (segment.includes("\0") || isAbsolute(segment)) {
      throw new Error("path_segment_invalid");
    }
  }
  const resolved = resolve(root, ...segments);
  if (resolved !== resolve(root) && !isPathInside(root, resolved)) {
    throw new Error("path_escapes_root");
  }
  return resolved;
}

/** `userDataDir` is `app.getPath("userData")` in production and a temp directory in tests. */
export function resolveAppPaths(userDataDir: string): AppPaths {
  if (!isAbsolute(userDataDir) || userDataDir.includes("\0")) {
    throw new Error("user_data_dir_must_be_absolute");
  }
  const root = join(resolve(userDataDir), APP_DIRECTORY_NAME);
  const database = join(root, "database");
  return {
    root,
    database,
    databaseFile: join(database, DATABASE_FILE_NAME),
    connectorAuth: join(root, "connector-auth"),
    logs: join(root, "logs"),
    exports: join(root, "exports"),
    backups: join(root, "backups"),
    settings: join(root, "settings"),
    media: join(root, "media"),
    thumbnails: join(root, "thumbnails"),
  };
}

export function ensureAppPaths(paths: AppPaths): AppPaths {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  for (const name of APP_SUBDIRECTORIES) {
    const directory = name === "connector-auth" ? paths.connectorAuth : paths[name];
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return paths;
}
