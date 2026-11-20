import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryKeyStore } from "@social-explorer/security";
import { deleteDatabaseFiles } from "@social-explorer/database";
import { afterEach, describe, expect, it } from "vitest";
import { createAppRuntime } from "./runtime.js";

describe("app runtime", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const base = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "se-runtime-"));
    dirs.push(dir);
    return dir;
  };

  it("boots directories, migrated SQLite and logger, then shuts down cleanly", async () => {
    const runtime = createAppRuntime({ userDataDir: base(), keyStore: new MemoryKeyStore() });
    expect(existsSync(runtime.paths.databaseFile)).toBe(true);
    expect(runtime.repositories.datasets.list()).toEqual([]);
    expect(runtime.db.open).toBe(true);
    const report = await runtime.shutdown.run();
    expect(report.failed).toEqual([]);
    expect(report.completed).toEqual(["sqlite", "logger"]);
    expect(runtime.db.open).toBe(false);
    expect(readFileSync(join(runtime.paths.logs, "social-explorer.log"), "utf8")).toContain(
      "runtime started",
    );
  });

  it("keeps connector auth intact when the database is deleted", async () => {
    const runtime = createAppRuntime({ userDataDir: base(), keyStore: new MemoryKeyStore() });
    await runtime.connectorAuth.setJson("creds", { synthetic: true });
    await runtime.shutdown.run();
    deleteDatabaseFiles(runtime.paths.databaseFile);
    expect(existsSync(runtime.paths.databaseFile)).toBe(false);
    expect(await runtime.connectorAuth.getJson("creds")).toEqual({ synthetic: true });
  });
});
