import { readFileSync } from "node:fs";
import type { ArchiveInput } from "./types.js";

const root = new URL("../../../fixtures/synthetic/", import.meta.url);

export function fixture(relative: string): ArchiveInput {
  const data = readFileSync(new URL(relative, root));
  return { name: relative.split("/").pop() ?? relative, data };
}

export const TXT_FIXTURES = [
  "exports/android-private.txt",
  "exports/android-group.txt",
  "exports/ios-private.txt",
  "exports/ios-group.txt",
] as const;

export const ZIP_FIXTURES = [
  "zips/android-private-with-media.zip",
  "zips/android-group-with-media.zip",
  "zips/ios-private-with-media.zip",
  "zips/ios-group-with-media.zip",
] as const;
