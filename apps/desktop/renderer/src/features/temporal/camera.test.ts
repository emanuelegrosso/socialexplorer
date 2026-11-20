import { describe, expect, it } from "vitest";
import {
  BASE_DISTANCE,
  CAMERA_FOV_DEGREES,
  cameraPose,
  clampZoom,
  distanceForZoom,
  fitCamera,
  panByPixels,
  screenToWorld,
  stepCamera,
  zoomAtPixel,
  type CameraState,
} from "./camera";
import { TemporalSceneCore, type RendererLike } from "./scene";
import { createSyntheticReadModel } from "./test-model";
import { buildLaneRegistry, worldBounds } from "./layout";
import { buildSceneFrame } from "./frame";
import { NO_SELECTION } from "./selection";

describe("WX-040 camera / pan / zoom / disposal", () => {
  const viewport = { width: 800, height: 600 };

  it("keeps a fixed perspective pose with no orbit state", () => {
    const pose = cameraPose({ centerX: 2, centerY: 8, zoom: 2 });
    expect(pose.position[2]).toBeCloseTo(BASE_DISTANCE / 2);
    expect(pose.target).toEqual([2, 8, 0]);
    expect(CAMERA_FOV_DEGREES).toBe(40);
  });

  it("pans and zooms deterministically and clamps zoom", () => {
    const base: CameraState = { centerX: 0, centerY: 10, zoom: 1 };
    const bounds = { minX: -5, maxX: 5, minY: 0, maxY: 20 };
    const panned = panByPixels(base, 80, 0, viewport, bounds);
    expect(panned.centerX).not.toBe(base.centerX);
    const zoomed = zoomAtPixel(base, 1.5, 400, 300, viewport, bounds);
    expect(zoomed.zoom).toBeGreaterThan(base.zoom);
    expect(clampZoom(100)).toBeLessThan(100);
    const anchor = screenToWorld(zoomed, 400, 300, viewport);
    const again = screenToWorld(zoomAtPixel(base, 1.5, 400, 300, viewport, bounds), 400, 300, viewport);
    expect(again.x).toBeCloseTo(anchor.x, 3);
    expect(again.y).toBeCloseTo(anchor.y, 3);
  });

  it("fits bounds and eases toward targets unless reduced motion", () => {
    const fit = fitCamera({ minX: -4, maxX: 4, minY: 0, maxY: 16 }, viewport);
    expect(fit.zoom).toBeGreaterThan(0);
    const start: CameraState = { centerX: 0, centerY: 0, zoom: 1 };
    const target: CameraState = { centerX: 1, centerY: 2, zoom: 3 };
    const stepped = stepCamera(start, target, 120, false);
    expect(stepped.centerX).toBeGreaterThan(0);
    expect(stepCamera(start, target, 120, true)).toEqual(target);
  });

  it("disposes geometries, materials and the renderer", () => {
    const disposables: string[] = [];
    const renderer: RendererLike = {
      setPixelRatio: () => undefined,
      setSize: () => undefined,
      render: () => undefined,
      dispose: () => {
        disposables.push("renderer");
      },
    };
    const core = new TemporalSceneCore(renderer, { reducedMotion: true });
    const model = createSyntheticReadModel();
    const registry = buildLaneRegistry(model);
    const frame = buildSceneFrame(model, {
      registry,
      zoom: 2,
      mode: "static",
      cursorMs: Date.parse(model.range.start),
      selection: NO_SELECTION,
      entityFilter: "all",
      reducedMotion: true,
    });
    core.setBounds(worldBounds(registry, frame.axis.height));
    core.setFrame(frame);
    expect(core.impulseInstanceCount).toBeGreaterThan(0);
    core.dispose();
    expect(core.isDisposed).toBe(true);
    expect(disposables).toEqual(["renderer"]);
    expect(distanceForZoom(2)).toBeCloseTo(BASE_DISTANCE / 2);
  });
});