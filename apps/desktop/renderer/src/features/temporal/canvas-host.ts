import { WebGLRenderer } from "three";
import type { SceneFrame } from "./frame";
import { TemporalSceneCore } from "./scene";

export interface CanvasHandlers {
  readonly onSelect: (entityId: string | undefined) => void;
  readonly onCamera?: (zoom: number) => void;
}

export interface OverlayLabel {
  readonly key: string;
  readonly kind: "lane" | "day" | "hour";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly entityId?: string;
  readonly color?: string;
  readonly active?: boolean;
}

export interface CanvasController {
  readonly core: TemporalSceneCore;
  setFrame(frame: SceneFrame, labels: readonly OverlayLabel[]): void;
  setReducedMotion(reduced: boolean): void;
  resetView(): void;
  zoomBy(factor: number): void;
  focusOn(x: number, y: number): void;
  dispose(): void;
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("webgl2") !== null || canvas.getContext("webgl") !== null;
  } catch {
    return false;
  }
}

/**
 * DOM glue around `TemporalSceneCore`: canvas, ResizeObserver, pan (drag) / zoom (wheel) input
 * and the HTML label overlay. There is deliberately no rotation input of any kind.
 */
export function mountTemporalCanvas(
  host: HTMLElement,
  handlers: CanvasHandlers,
  reducedMotion: boolean,
): CanvasController {
  const canvas = document.createElement("canvas");
  canvas.className = "temporal-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Temporal interaction flow: past at the top, present at the bottom. Drag to pan, scroll to zoom.",
  );
  const overlay = document.createElement("div");
  overlay.className = "temporal-overlay";
  host.replaceChildren(canvas, overlay);

  const renderer = new WebGLRenderer({ canvas, antialias: true });
  const core = new TemporalSceneCore(renderer, { reducedMotion });
  let labels: readonly OverlayLabel[] = [];
  const elements = new Map<string, HTMLElement>();
  let frameHandle = 0;
  let last = performance.now();
  let disposed = false;
  let lastZoom = -1;

  const resize = (): void => {
    core.setViewport(host.clientWidth, host.clientHeight, Math.min(window.devicePixelRatio, 2));
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const syncLabels = (): void => {
    const live = new Set<string>();
    for (const label of labels) {
      live.add(label.key);
      let element = elements.get(label.key);
      if (element === undefined) {
        element =
          label.kind === "lane"
            ? document.createElement("button")
            : document.createElement("span");
        element.className = `temporal-label temporal-label-${label.kind}`;
        if (label.kind === "lane" && label.entityId !== undefined) {
          const entityId = label.entityId;
          element.setAttribute("type", "button");
          element.addEventListener("click", () => {
            handlers.onSelect(entityId);
          });
        }
        overlay.append(element);
        elements.set(label.key, element);
      }
      if (element.textContent !== label.text) {
        element.textContent = label.text;
      }
      element.toggleAttribute("data-active", label.active === true);
      if (label.color !== undefined) {
        element.style.setProperty("--lane-color", label.color);
      }
      const point = core.project(label.x, label.y, label.z);
      element.hidden = !point.visible;
      element.style.transform = `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;
    }
    for (const [key, element] of elements) {
      if (!live.has(key)) {
        element.remove();
        elements.delete(key);
      }
    }
  };

  const loop = (now: number): void => {
    if (disposed) {
      return;
    }
    core.update(now, now - last);
    last = now;
    syncLabels();
    if (core.cameraState.zoom !== lastZoom) {
      lastZoom = core.cameraState.zoom;
      handlers.onCamera?.(lastZoom);
    }
    frameHandle = requestAnimationFrame(loop);
  };
  frameHandle = requestAnimationFrame(loop);

  let drag: { id: number; x: number; y: number; moved: number } | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) {
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag = { ...drag, x: event.clientX, y: event.clientY, moved: drag.moved + Math.abs(dx) + Math.abs(dy) };
    core.panByPixels(dx, dy);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (drag?.id !== event.pointerId) {
      return;
    }
    const wasClick = drag.moved < 4;
    drag = undefined;
    if (wasClick) {
      const rect = canvas.getBoundingClientRect();
      const lanes = core.currentFrame?.lanes ?? [];
      handlers.onSelect(core.pickLane(event.clientX - rect.left, event.clientY - rect.top, lanes));
    }
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    core.zoomAtPixel(
      Math.exp(-event.deltaY * 0.0015),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });

  return {
    core,
    setFrame(frame, nextLabels) {
      labels = nextLabels;
      core.setFrame(frame);
    },
    setReducedMotion(reduced) {
      core.setReducedMotion(reduced);
    },
    resetView() {
      core.resetView();
    },
    zoomBy(factor) {
      core.zoomAtPixel(factor, host.clientWidth / 2, host.clientHeight / 2);
    },
    focusOn(x, y) {
      core.focusOn(x, y);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frameHandle);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      core.dispose();
      host.replaceChildren();
    },
  };
}
