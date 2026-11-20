import { useEffect, useRef } from "react";
import { mountTemporalCanvas, webglAvailable, type CanvasController, type OverlayLabel } from "./canvas-host";
import type { SceneFrame } from "./frame";

export function TemporalScene(props: {
  readonly frame: SceneFrame;
  readonly labels: readonly OverlayLabel[];
  readonly reducedMotion: boolean;
  readonly onSelect: (entityId: string | undefined) => void;
  readonly onZoom: (zoom: number) => void;
  readonly onReady?: (controller: CanvasController) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<CanvasController | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null || !webglAvailable()) {
      return;
    }
    const controller = mountTemporalCanvas(
      host,
      { onSelect: props.onSelect, onCamera: props.onZoom },
      props.reducedMotion,
    );
    controllerRef.current = controller;
    props.onReady?.(controller);
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [props.onReady, props.onSelect, props.onZoom, props.reducedMotion]);

  useEffect(() => {
    controllerRef.current?.setReducedMotion(props.reducedMotion);
  }, [props.reducedMotion]);

  useEffect(() => {
    controllerRef.current?.setFrame(props.frame, props.labels);
  }, [props.frame, props.labels]);

  if (!webglAvailable()) {
    return (
      <p className="explorer-fallback">
        WebGL is not available in this environment. The 3D temporal view is disabled.
      </p>
    );
  }
  return <div ref={hostRef} className="temporal-stage" data-testid="temporal-stage" />;
}