/**
 * Fixed-orientation camera model. The camera always looks straight down -Z; the only degrees of
 * freedom are the pan center and a zoom factor (dolly distance). There is intentionally no
 * rotation, orbit, or roll state.
 */
export const CAMERA_FOV_DEGREES = 40;
export const BASE_DISTANCE = 30;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 40;

export interface CameraState {
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface WorldBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface CameraPose {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

const TAN_HALF_FOV = Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360);

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const clampZoom = (zoom: number): number => clamp(zoom, MIN_ZOOM, MAX_ZOOM);

export const distanceForZoom = (zoom: number): number => BASE_DISTANCE / clampZoom(zoom);

/** World units per screen pixel on the z = 0 plane. */
export function worldPerPixel(zoom: number, viewport: Viewport): number {
  return (2 * distanceForZoom(zoom) * TAN_HALF_FOV) / Math.max(viewport.height, 1);
}

export function clampCenter(state: CameraState, bounds: WorldBounds): CameraState {
  return {
    ...state,
    centerX: clamp(state.centerX, bounds.minX, bounds.maxX),
    centerY: clamp(state.centerY, bounds.minY, bounds.maxY),
  };
}

export function panByPixels(
  state: CameraState,
  dxPixels: number,
  dyPixels: number,
  viewport: Viewport,
  bounds: WorldBounds,
): CameraState {
  const scale = worldPerPixel(state.zoom, viewport);
  return clampCenter(
    {
      ...state,
      centerX: state.centerX - dxPixels * scale,
      centerY: state.centerY + dyPixels * scale,
    },
    bounds,
  );
}

/** World point (z = 0) under a pixel for the given camera state. */
export function screenToWorld(
  state: CameraState,
  pixelX: number,
  pixelY: number,
  viewport: Viewport,
): { readonly x: number; readonly y: number } {
  const scale = worldPerPixel(state.zoom, viewport);
  return {
    x: state.centerX + (pixelX - viewport.width / 2) * scale,
    y: state.centerY - (pixelY - viewport.height / 2) * scale,
  };
}

/** Zooms by `factor` keeping the world point under the pixel stationary. */
export function zoomAtPixel(
  state: CameraState,
  factor: number,
  pixelX: number,
  pixelY: number,
  viewport: Viewport,
  bounds: WorldBounds,
): CameraState {
  const anchor = screenToWorld(state, pixelX, pixelY, viewport);
  const zoom = clampZoom(state.zoom * factor);
  const scale = worldPerPixel(zoom, viewport);
  return clampCenter(
    {
      zoom,
      centerX: anchor.x - (pixelX - viewport.width / 2) * scale,
      centerY: anchor.y + (pixelY - viewport.height / 2) * scale,
    },
    bounds,
  );
}

/** Camera that shows the whole bounds with a small margin. */
export function fitCamera(bounds: WorldBounds, viewport: Viewport): CameraState {
  const aspect = Math.max(viewport.width, 1) / Math.max(viewport.height, 1);
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const distance = Math.max(height / (2 * TAN_HALF_FOV), width / (2 * TAN_HALF_FOV * aspect));
  return {
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
    zoom: clampZoom(BASE_DISTANCE / Math.max(distance * 1.05, 1)),
  };
}

export function cameraPose(state: CameraState): CameraPose {
  return {
    position: [state.centerX, state.centerY, distanceForZoom(state.zoom)],
    target: [state.centerX, state.centerY, 0],
  };
}

export const sameCamera = (a: CameraState, b: CameraState): boolean =>
  Math.abs(a.centerX - b.centerX) < 1e-4 &&
  Math.abs(a.centerY - b.centerY) < 1e-4 &&
  Math.abs(a.zoom - b.zoom) < 1e-4;

/** Exponential smoothing toward `target`; snaps immediately when motion is reduced. */
export function stepCamera(
  current: CameraState,
  target: CameraState,
  deltaMs: number,
  reducedMotion: boolean,
): CameraState {
  if (reducedMotion || sameCamera(current, target)) {
    return target;
  }
  const alpha = 1 - Math.exp(-Math.max(deltaMs, 0) / 90);
  const next = {
    centerX: current.centerX + (target.centerX - current.centerX) * alpha,
    centerY: current.centerY + (target.centerY - current.centerY) * alpha,
    zoom: current.zoom * Math.pow(target.zoom / current.zoom, alpha),
  };
  return sameCamera(next, target) ? target : next;
}
