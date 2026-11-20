import { describe, expect, it } from "vitest";
import { ShutdownRegistry } from "./lifecycle.js";

describe("ShutdownRegistry", () => {
  it("runs tasks once in reverse order and keeps going after failures", async () => {
    const order: string[] = [];
    const registry = new ShutdownRegistry();
    registry.register("logger", () => {
      order.push("logger");
    });
    registry.register("sqlite", () => {
      throw new Error("close failed");
    });
    registry.register("worker", async () => {
      await Promise.resolve();
      order.push("worker");
    });
    expect(registry.isShuttingDown).toBe(false);
    const [a, b] = await Promise.all([registry.run(), registry.run()]);
    expect(a).toBe(b);
    expect(order).toEqual(["worker", "logger"]);
    expect(a.completed).toEqual(["worker", "logger"]);
    expect(a.failed.map((f) => f.name)).toEqual(["sqlite"]);
    expect(registry.isShuttingDown).toBe(true);
    await registry.run();
    expect(order).toHaveLength(2);
  });
});
