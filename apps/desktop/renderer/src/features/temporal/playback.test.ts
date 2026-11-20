import { describe, expect, it } from "vitest";
import {
  createPlayback,
  pause,
  play,
  seek,
  setSpeed,
  stepBack,
  stepForward,
  tick,
  playbackStops,
} from "./playback";
import { createSyntheticReadModel } from "./test-model";

describe("WX-045 chronological playback", () => {
  const model = createSyntheticReadModel();
  const startMs = Date.parse(model.range.start);
  const endMs = Date.parse(model.range.end);
  const stops = playbackStops(model);

  it("plays forward, seeks, and steps through stops", () => {
    let state = createPlayback(startMs, endMs);
    state = play(state);
    expect(state.playing).toBe(true);
    state = tick(state, 500, stops);
    expect(state.cursorMs).toBeGreaterThan(startMs);
    state = pause(state);
    expect(state.playing).toBe(false);
    state = setSpeed(state, 5);
    expect(state.speed).toBe(5);
    const mid = stops[Math.floor(stops.length / 2)] ?? startMs;
    state = seek(state, mid);
    expect(state.cursorMs).toBe(mid);
    state = stepForward(state, stops);
    expect(state.cursorMs).toBeGreaterThanOrEqual(mid);
    state = stepBack(state, stops);
    expect(state.cursorMs).toBeLessThanOrEqual(mid);
  });

  it("advances by discrete stops under reduced motion", () => {
    let state = play(createPlayback(startMs, endMs, true));
    const before = state.cursorMs;
    state = tick(state, 2000, stops);
    expect(state.cursorMs).toBeGreaterThanOrEqual(before);
  });
});