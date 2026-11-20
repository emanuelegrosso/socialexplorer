import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSupervised, validateArgs, validateExecutable, type RunnerEvent } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "se-runner-test-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fake(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const progressScript = fake(
  "progress.mjs",
  `for (const t of [250000, 500000, 1000000]) process.stdout.write("frame=1\\nout_time_us=" + t + "\\ntotal_size=1000\\nspeed=2x\\nprogress=continue\\n");
process.stdout.write("out_time_us=1000000\\nprogress=end\\n");`,
);

describe("supervised runner", () => {
  it("emits structured progress and completes", async () => {
    const events: RunnerEvent[] = [];
    const outcome = await runSupervised({ executable: progressScript, args: [], expectedDurationMs: 1000, onEvent: (e) => events.push(e) });
    expect(outcome.status).toBe("completed");
    const fractions = events.flatMap((e) => (e.type === "progress" ? [e.progress.fraction] : []));
    expect(fractions).toEqual([0.25, 0.5, 0.999, 1]);
    expect(events[0]?.type).toBe("started");
    expect(events.at(-1)).toEqual({ type: "finished", status: "completed" });
  });

  it("reports failures with a bounded stderr tail", async () => {
    const bad = fake("fail.mjs", `process.stderr.write("x".repeat(5000) + "boom"); process.exit(3);`);
    const outcome = await runSupervised({ executable: bad, args: [], maxStderrBytes: 100 });
    expect(outcome.status).toBe("failed");
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderrTail).toHaveLength(100);
    expect(outcome.stderrTail.endsWith("boom")).toBe(true);
  });

  it("cancels via AbortSignal and escalates to SIGKILL when SIGTERM is ignored", async () => {
    const stubborn = fake("stubborn.mjs", `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const started = Date.now();
    const pending = runSupervised({ executable: stubborn, args: [], signal: controller.signal, killGraceMs: 200 });
    setTimeout(() => {
      controller.abort();
    }, 150);
    const outcome = await pending;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.signal).toBe("SIGKILL");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not spawn when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = join(dir, "never-ran");
    const script = fake("marker.cjs", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`);
    expect((await runSupervised({ executable: script, args: [], signal: controller.signal })).status).toBe("cancelled");
    expect(existsSync(marker)).toBe(false);
  });

  it("enforces a timeout", async () => {
    const hang = fake("hang.mjs", `setInterval(() => {}, 1000);`);
    const outcome = await runSupervised({ executable: hang, args: [], timeoutMs: 150, killGraceMs: 100 });
    expect(outcome.status).toBe("timeout");
  });

  it("enforces the output size limit", async () => {
    const big = fake(
      "big.mjs",
      `process.stdout.write("out_time_us=1000\\ntotal_size=999999\\nprogress=continue\\n"); setInterval(() => {}, 1000);`,
    );
    const outcome = await runSupervised({ executable: big, args: [], maxOutputBytes: 1000, killGraceMs: 100 });
    expect(outcome.status).toBe("limit-exceeded");
  });

  it("reports spawn errors and rejects unsafe executables or arguments", async () => {
    expect((await runSupervised({ executable: join(dir, "missing"), args: [] })).status).toBe("spawn-error");
    expect((await runSupervised({ executable: "ffmpeg; rm -rf /", args: [] })).status).toBe("spawn-error");
    expect((await runSupervised({ executable: "sh -c ls", args: [] })).status).toBe("spawn-error");
    expect((await runSupervised({ executable: progressScript, args: ["a\0b"] })).status).toBe("spawn-error");
    expect(() => {
      validateExecutable("");
    }).toThrow();
    expect(() => {
      validateArgs(Array.from({ length: 5000 }, () => "x"));
    }).toThrow();
    expect(() => {
      validateExecutable("ffmpeg");
    }).not.toThrow();
  });

  it("passes shell metacharacters through as literal arguments", async () => {
    const out = join(dir, "args.json");
    const echo = fake("echo.cjs", `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)))`);
    const nasty = ["$(touch /tmp/pwned)", "; rm -rf /", "`id`", "a b", "*"];
    const outcome = await runSupervised({ executable: echo, args: nasty });
    expect(outcome.status).toBe("completed");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(nasty);
    expect(existsSync("/tmp/pwned")).toBe(false);
  });
});
