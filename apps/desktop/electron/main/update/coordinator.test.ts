import { describe, expect, it } from "vitest";
import { freeEntitlement } from "@social-explorer/licensing";
import { createLogger, createMemoryLogSink } from "@social-explorer/security";
import { createUpdateCoordinator } from "./coordinator.js";

describe("UpdateCoordinator", () => {
  it("skips checks in unpackaged dev builds", async () => {
    const logger = createLogger({ level: "error", sink: createMemoryLogSink() });
    const coordinator = createUpdateCoordinator({
      logger,
      getEntitlement: () => freeEntitlement(),
      isPackaged: false,
      connectorAbiLabel: "connector-pinned",
    });
    const outcome = await coordinator.prepareCheck(Date.now());
    expect(outcome).toMatchObject({ checked: false, skippedReason: "dev_build" });
    await logger.close();
  });

  it("records rollback anchor", async () => {
    const logger = createLogger({ level: "error", sink: createMemoryLogSink() });
    const coordinator = createUpdateCoordinator({
      logger,
      getEntitlement: () => freeEntitlement(),
      isPackaged: false,
      connectorAbiLabel: "connector-pinned",
    });
    coordinator.markRollbackAnchor("0.9.0");
    expect(coordinator.planRollback()).toEqual({
      action: "reinstall-previous",
      version: "0.9.0",
    });
    await logger.close();
  });
});