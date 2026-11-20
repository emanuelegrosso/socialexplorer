import {
  BufferGeometry,
  Camera,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";
import { pointOnCurve, pulseProgress } from "./arcs";
import {
  CAMERA_FOV_DEGREES,
  cameraPose,
  clampCenter,
  fitCamera,
  panByPixels,
  screenToWorld,
  stepCamera,
  worldPerPixel,
  zoomAtPixel,
  clampZoom,
  type CameraState,
  type Viewport,
  type WorldBounds,
} from "./camera";
import { MAX_PULSES, type FrameLane, type SceneFrame } from "./frame";

export const SCENE_BACKGROUND = 0x071321;
const ARC_SEGMENTS = 20;

/** The slice of `WebGLRenderer` the scene needs; lets tests run without a GPU. */
export interface RendererLike {
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}

export interface SceneOptions {
  readonly reducedMotion: boolean;
}

interface Disposable {
  dispose(): void;
}

const scaled = (hex: string, factor: number): [number, number, number] => {
  const color = new Color(hex);
  return [color.r * factor, color.g * factor, color.b * factor];
};

function lineSegments(
  positions: number[],
  colors: number[],
  tracker: Disposable[],
): LineSegments {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  const material = new LineBasicMaterial({ vertexColors: true });
  tracker.push(geometry, material);
  const lines = new LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

/**
 * Pure Three.js scene for the Temporal Interaction Flow. It owns a perspective camera whose
 * orientation is fixed (identity rotation): the user can only pan and zoom, never orbit.
 */
export class TemporalSceneCore {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 0.1, 600);
  private viewport: Viewport = { width: 1, height: 1 };
  private bounds: WorldBounds = { minX: -2, maxX: 2, minY: -1, maxY: 15 };
  private current: CameraState = { centerX: 0, centerY: 7, zoom: 1 };
  private target: CameraState = this.current;
  private frame: SceneFrame | undefined;
  private content: Object3D[] = [];
  private contentDisposables: Disposable[] = [];
  private impulseMesh: InstancedMesh | undefined;
  private pulseMesh: InstancedMesh | undefined;
  private pulseGeometry: SphereGeometry | undefined;
  private pulseMaterial: MeshBasicMaterial | undefined;
  private readonly matrix = new Matrix4();
  private disposed = false;
  private fitted = false;

  constructor(
    private readonly renderer: RendererLike,
    private options: SceneOptions,
  ) {
    this.scene.background = new Color(SCENE_BACKGROUND);
    this.camera.rotation.set(0, 0, 0);
    this.applyCamera();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get cameraState(): CameraState {
    return this.current;
  }

  get targetState(): CameraState {
    return this.target;
  }

  get currentFrame(): SceneFrame | undefined {
    return this.frame;
  }

  setReducedMotion(reducedMotion: boolean): void {
    this.options = { reducedMotion };
    if (reducedMotion) {
      this.current = this.target;
      this.applyCamera();
    }
  }

  setViewport(width: number, height: number, pixelRatio = 1): void {
    if (this.disposed) {
      return;
    }
    this.viewport = { width: Math.max(width, 1), height: Math.max(height, 1) };
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.viewport.width, this.viewport.height, false);
    this.camera.aspect = this.viewport.width / this.viewport.height;
    this.camera.updateProjectionMatrix();
    this.applyCamera();
  }

  setBounds(bounds: WorldBounds): void {
    this.bounds = bounds;
    if (!this.fitted) {
      this.resetView(true);
      this.fitted = true;
    } else {
      this.target = clampCenter(this.target, bounds);
    }
  }

  resetView(immediate = false): void {
    this.target = fitCamera(this.bounds, this.viewport);
    if (immediate || this.options.reducedMotion) {
      this.current = this.target;
      this.applyCamera();
    }
  }

  panByPixels(dx: number, dy: number): void {
    this.target = panByPixels(this.target, dx, dy, this.viewport, this.bounds);
    this.current = this.target;
    this.applyCamera();
  }

  zoomAtPixel(factor: number, pixelX: number, pixelY: number): void {
    this.target = zoomAtPixel(this.target, factor, pixelX, pixelY, this.viewport, this.bounds);
  }

  focusOn(x: number, y: number, zoom?: number): void {
    this.target = clampCenter(
      {
        centerX: x,
        centerY: y,
        zoom: clampZoom(zoom ?? Math.max(this.target.zoom, 3)),
      },
      this.bounds,
    );
  }

  worldAt(pixelX: number, pixelY: number): { x: number; y: number } {
    return screenToWorld(this.current, pixelX, pixelY, this.viewport);
  }

  pickLane(pixelX: number, pixelY: number, lanes: readonly FrameLane[]): string | undefined {
    const world = this.worldAt(pixelX, pixelY);
    const tolerance = Math.max(0.7, 14 * worldPerPixel(this.current.zoom, this.viewport));
    const height = this.frame?.axis.height ?? this.bounds.maxY;
    if (world.y < -1 || world.y > height + 1) {
      return undefined;
    }
    let best: { id: string; distance: number } | undefined;
    for (const lane of lanes) {
      const distance = Math.abs(lane.x - world.x);
      if (distance <= tolerance && (best === undefined || distance < best.distance)) {
        best = { id: lane.entityId, distance };
      }
    }
    return best?.id;
  }

  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    const vector = new Vector3(x, y, z).project(this.camera);
    return {
      x: (vector.x * 0.5 + 0.5) * this.viewport.width,
      y: (-vector.y * 0.5 + 0.5) * this.viewport.height,
      visible: vector.z < 1 && Math.abs(vector.x) <= 1.15 && Math.abs(vector.y) <= 1.15,
    };
  }

  private applyCamera(): void {
    const pose = cameraPose(this.current);
    this.camera.position.set(...pose.position);
    // Orientation is never changed: the camera permanently looks along -Z.
    this.camera.rotation.set(0, 0, 0);
    this.camera.updateMatrixWorld(true);
  }

  private clearContent(): void {
    for (const object of this.content) {
      this.scene.remove(object);
    }
    this.content = [];
    for (const item of this.contentDisposables) {
      item.dispose();
    }
    this.contentDisposables = [];
    this.impulseMesh = undefined;
    this.pulseMesh = undefined;
  }

  setFrame(frame: SceneFrame): void {
    if (this.disposed) {
      return;
    }
    this.clearContent();
    this.frame = frame;
    const tracker = this.contentDisposables;
    const { height } = frame.axis;
    const minX = this.bounds.minX;
    const maxX = this.bounds.maxX;

    const lanePositions: number[] = [];
    const laneColors: number[] = [];
    for (const lane of frame.lanes) {
      const color = scaled(lane.color, lane.opacity);
      lanePositions.push(lane.x, height, lane.z, lane.x, 0, lane.z);
      laneColors.push(...color, ...color);
    }
    this.addContent(lineSegments(lanePositions, laneColors, tracker));

    const gridPositions: number[] = [];
    const gridColors: number[] = [];
    const dayColor = scaled("#4A6A8C", 0.8);
    for (const day of frame.marks.days) {
      gridPositions.push(minX, day.y, -0.2, maxX, day.y, -0.2);
      gridColors.push(...dayColor, ...dayColor);
    }
    const hourColor = scaled("#4A6A8C", 0.45);
    for (const hour of frame.marks.hours) {
      gridPositions.push(minX, hour.y, -0.2, minX + 0.6, hour.y, -0.2);
      gridColors.push(...hourColor, ...hourColor);
    }
    this.addContent(lineSegments(gridPositions, gridColors, tracker));

    const arcPositions: number[] = [];
    const arcColors: number[] = [];
    for (const arc of frame.arcs) {
      const base = new Color(arc.color);
      let previous = pointOnCurve(arc.curve, 0);
      for (let step = 1; step <= ARC_SEGMENTS; step++) {
        const next = pointOnCurve(arc.curve, step / ARC_SEGMENTS);
        const fadeA = arc.opacity * (0.35 + 0.65 * ((step - 1) / ARC_SEGMENTS));
        const fadeB = arc.opacity * (0.35 + 0.65 * (step / ARC_SEGMENTS));
        arcPositions.push(previous.x, previous.y, previous.z, next.x, next.y, next.z);
        arcColors.push(
          base.r * fadeA, base.g * fadeA, base.b * fadeA,
          base.r * fadeB, base.g * fadeB, base.b * fadeB,
        );
        previous = next;
      }
    }
    this.addContent(lineSegments(arcPositions, arcColors, tracker));

    const sphere = new SphereGeometry(1, 10, 8);
    const impulseMaterial = new MeshBasicMaterial();
    tracker.push(sphere, impulseMaterial);
    const impulses = new InstancedMesh(sphere, impulseMaterial, Math.max(frame.impulses.length, 1));
    impulses.count = frame.impulses.length;
    impulses.frustumCulled = false;
    const tint = new Color();
    frame.impulses.forEach((impulse, index) => {
      this.matrix.makeScale(impulse.radius, impulse.radius, impulse.radius);
      this.matrix.setPosition(impulse.x, impulse.y, impulse.z);
      impulses.setMatrixAt(index, this.matrix);
      tint.set(impulse.color).multiplyScalar(impulse.opacity);
      impulses.setColorAt(index, tint);
    });
    impulses.instanceMatrix.needsUpdate = true;
    if (impulses.instanceColor !== null) {
      impulses.instanceColor.needsUpdate = true;
    }
    tracker.push(impulses);
    this.impulseMesh = impulses;
    this.addContent(impulses);

    if (frame.playheadY !== undefined) {
      const color = scaled("#35D0FF", 0.9);
      this.addContent(
        lineSegments(
          [minX, frame.playheadY, 0.2, maxX, frame.playheadY, 0.2],
          [...color, ...color],
          tracker,
        ),
      );
    }

    this.pulseGeometry = new SphereGeometry(0.11, 8, 6);
    this.pulseMaterial = new MeshBasicMaterial({ color: 0xffffff });
    tracker.push(this.pulseGeometry, this.pulseMaterial);
    const pulses = new InstancedMesh(this.pulseGeometry, this.pulseMaterial, MAX_PULSES);
    pulses.count = 0;
    pulses.frustumCulled = false;
    tracker.push(pulses);
    this.pulseMesh = pulses;
    this.addContent(pulses);
    this.updatePulses(0);
  }

  private addContent(object: Object3D): void {
    this.content.push(object);
    this.scene.add(object);
  }

  get impulseInstanceCount(): number {
    return this.impulseMesh?.count ?? 0;
  }

  /** Moves the directional pulses along their arcs (source -> target). No-op under reduced motion. */
  updatePulses(timeMs: number): void {
    const mesh = this.pulseMesh;
    const frame = this.frame;
    if (mesh === undefined || frame === undefined) {
      return;
    }
    if (this.options.reducedMotion) {
      mesh.count = 0;
      return;
    }
    const byId = new Map(frame.arcs.map((arc) => [arc.id, arc]));
    const white = new Color(0xffffff);
    let index = 0;
    for (const id of frame.pulseArcIds) {
      const arc = byId.get(id);
      if (arc === undefined || index >= MAX_PULSES) {
        continue;
      }
      const point = pointOnCurve(arc.curve, pulseProgress(arc.id, timeMs));
      this.matrix.makeTranslation(point.x, point.y, point.z);
      mesh.setMatrixAt(index, this.matrix);
      mesh.setColorAt(index, white.clone().lerp(new Color(arc.color), 0.4));
      index += 1;
    }
    mesh.count = index;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) {
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Advances smoothing and pulses, then draws one frame. */
  update(timeMs: number, deltaMs: number): void {
    if (this.disposed) {
      return;
    }
    this.current = stepCamera(this.current, this.target, deltaMs, this.options.reducedMotion);
    this.applyCamera();
    this.updatePulses(timeMs);
    this.renderer.render(this.scene, this.camera);
  }

  /** Releases every geometry, material and the renderer; safe to call more than once. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearContent();
    this.scene.clear();
    this.renderer.dispose();
  }
}
