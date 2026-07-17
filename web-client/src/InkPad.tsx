import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import {
  appendOrderedPoints,
  isPrimaryPointerStart,
  pointsFromPointerEvent,
  resizeTransform,
  strokeToViewport,
  viewportPointToCanonical,
} from "./ink/capture";
import type {
  LogicalSurface,
  PointerOrigin,
  UniformTransform,
} from "./ink/capture";
import { rasterizeInk } from "./ink/rasterize";
import type { RasterizedInk } from "./ink/rasterize";
import {
  clearInk,
  drawInk,
  normalizedDevicePixelRatio,
  renderInk,
  resizeCanvas,
  watchDevicePixelRatio,
} from "./ink/render";
import type { CanvasMetrics, VisibleInkStyle } from "./ink/render";
import type { ImmutableInkStroke, InkStroke } from "./ink/types";

interface ActiveStroke {
  pointerId: number;
  stroke: InkStroke;
}

export interface InkStats {
  strokeCount: number;
  pointCount: number;
}

export type StrokeCancellationReason =
  "pointercancel" | "lost-capture" | "resize" | "orientation" | "disabled";

export interface InkPadHandle {
  isPointerActive(): boolean;
  getLatestPointTime(): number | null;
  getStats(): InkStats;
  getStrokes(): readonly ImmutableInkStroke[];
  rasterize(): RasterizedInk | null;
  clear(): void;
}

export interface InkPadProps {
  enabled?: boolean;
  className?: string;
  onPointerAccepted?: () => void;
  onActivePointerChange?: (active: boolean) => void;
  onStrokeComplete?: (stats: InkStats) => void;
  onStrokeCancel?: (reason: StrokeCancellationReason, stats: InkStats) => void;
  onClear?: () => void;
}

function inkStats(strokes: readonly InkStroke[]): InkStats {
  return {
    strokeCount: strokes.length,
    pointCount: strokes.reduce(
      (count, stroke) => count + stroke.points.length,
      0,
    ),
  };
}

function immutableStrokeSnapshot(
  strokes: readonly InkStroke[],
): readonly ImmutableInkStroke[] {
  return Object.freeze(
    strokes.map((stroke) =>
      Object.freeze({
        points: Object.freeze(
          stroke.points.map((point) => Object.freeze({ ...point })),
        ),
      }),
    ),
  );
}

function latestCompletedPointTime(
  strokes: readonly InkStroke[],
): number | null {
  let latest: number | null = null;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      latest = latest === null ? point.time : Math.max(latest, point.time);
    }
  }
  return latest;
}

export const InkPad = forwardRef<InkPadHandle, InkPadProps>(function InkPad(
  {
    enabled = true,
    className = "",
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onClear,
  },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const completedStrokesRef = useRef<InkStroke[]>([]);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const latestPointTimeRef = useRef<number | null>(null);
  const clearRef = useRef<() => void>(() => undefined);
  const cancelRef = useRef<
    (reason: StrokeCancellationReason, notify?: boolean) => void
  >(() => undefined);
  const propsRef = useRef({
    enabled,
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onClear,
  });

  useLayoutEffect(() => {
    propsRef.current = {
      enabled,
      onPointerAccepted,
      onActivePointerChange,
      onStrokeComplete,
      onStrokeCancel,
      onClear,
    };
  }, [
    enabled,
    onPointerAccepted,
    onActivePointerChange,
    onStrokeComplete,
    onStrokeCancel,
    onClear,
  ]);

  useLayoutEffect(() => {
    if (!enabled) {
      cancelRef.current("disabled");
    }
  }, [enabled]);

  useImperativeHandle(
    ref,
    () => ({
      isPointerActive: () => activeStrokeRef.current !== null,
      getLatestPointTime: () => latestPointTimeRef.current,
      getStats: () => inkStats(completedStrokesRef.current),
      getStrokes: () => immutableStrokeSnapshot(completedStrokesRef.current),
      rasterize: () => rasterizeInk(completedStrokesRef.current),
      clear: () => clearRef.current(),
    }),
    [],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    // A detached canvas works in Safari and keeps completed vectors off the hot path.
    const completedInkCanvas = document.createElement("canvas");
    let metrics: CanvasMetrics | null = null;
    let canonicalSurface: LogicalSurface | null = null;
    let viewportTransform: UniformTransform | null = null;
    let pointerOrigin: PointerOrigin = { left: 0, top: 0 };
    let animationFrame: number | null = null;
    let orientationFrame: number | null = null;

    const visibleStyle = (): Partial<VisibleInkStyle> => {
      if (!metrics) {
        return {};
      }
      const scale = Math.min(metrics.logicalWidth, metrics.logicalHeight);
      return {
        minWidth: Math.max(3.8, Math.min(5.5, scale * 0.011)),
        maxWidth: Math.max(7, Math.min(10.5, scale * 0.02)),
      };
    };

    const viewportStroke = (stroke: InkStroke): InkStroke => {
      return viewportTransform
        ? strokeToViewport(stroke, viewportTransform)
        : stroke;
    };

    const rebuildCompletedInk = () => {
      if (!metrics) {
        return;
      }
      resizeCanvas(
        completedInkCanvas,
        metrics.logicalWidth,
        metrics.logicalHeight,
        metrics.dpr,
      );
      const context = completedInkCanvas.getContext("2d");
      if (!context) {
        return;
      }
      renderInk(
        context,
        completedStrokesRef.current.map(viewportStroke),
        metrics.logicalWidth,
        metrics.logicalHeight,
        visibleStyle(),
      );
    };

    const appendCompletedInk = (stroke: InkStroke) => {
      const context = completedInkCanvas.getContext("2d");
      if (!context) {
        return;
      }
      drawInk(context, [viewportStroke(stroke)], visibleStyle());
    };

    const paint = () => {
      animationFrame = null;
      const context = canvas.getContext("2d");
      if (!context || !metrics) {
        return;
      }
      clearInk(context, metrics.logicalWidth, metrics.logicalHeight);
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(completedInkCanvas, 0, 0);
      context.restore();

      const active = activeStrokeRef.current;
      if (active) {
        drawInk(context, [viewportStroke(active.stroke)], visibleStyle());
      }
    };

    const requestPaint = () => {
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(paint);
      }
    };

    const releaseCapture = (pointerId: number) => {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    };

    const cancelActiveStroke = (
      reason: StrokeCancellationReason,
      notify = true,
    ) => {
      const active = activeStrokeRef.current;
      if (!active) {
        return;
      }
      activeStrokeRef.current = null;
      releaseCapture(active.pointerId);
      latestPointTimeRef.current = latestCompletedPointTime(
        completedStrokesRef.current,
      );
      propsRef.current.onActivePointerChange?.(false);
      if (notify) {
        propsRef.current.onStrokeCancel?.(
          reason,
          inkStats(completedStrokesRef.current),
        );
      }
      requestPaint();
    };
    cancelRef.current = cancelActiveStroke;

    const resizeSurface = () => {
      cancelActiveStroke("resize");
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) {
        return;
      }
      pointerOrigin = { left: bounds.left, top: bounds.top };
      metrics = resizeCanvas(
        canvas,
        bounds.width,
        bounds.height,
        window.devicePixelRatio,
      );
      if (!canonicalSurface || completedStrokesRef.current.length === 0) {
        canonicalSurface = {
          width: metrics.logicalWidth,
          height: metrics.logicalHeight,
        };
      }
      viewportTransform = resizeTransform(canonicalSurface, {
        width: metrics.logicalWidth,
        height: metrics.logicalHeight,
      });
      rebuildCompletedInk();
      requestPaint();
    };

    const capturedPoints = (event: PointerEvent) => {
      const points = pointsFromPointerEvent(event, pointerOrigin);
      const transform = viewportTransform;
      return transform
        ? points.map((point) => viewportPointToCanonical(point, transform))
        : points;
    };

    const appendCapturedPoints = (stroke: InkStroke, event: PointerEvent) => {
      const points = capturedPoints(event);
      appendOrderedPoints(stroke.points, points);
      const latest = stroke.points.at(-1)?.time;
      if (latest !== undefined) {
        latestPointTimeRef.current = latest;
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        !propsRef.current.enabled ||
        !isPrimaryPointerStart(
          event,
          activeStrokeRef.current?.pointerId ?? null,
        )
      ) {
        return;
      }

      if (
        metrics?.dpr !== normalizedDevicePixelRatio(window.devicePixelRatio)
      ) {
        resizeSurface();
      }
      event.preventDefault();
      propsRef.current.onPointerAccepted?.();
      const stroke: InkStroke = { points: [] };
      appendCapturedPoints(stroke, event);
      activeStrokeRef.current = { pointerId: event.pointerId, stroke };
      propsRef.current.onActivePointerChange?.(true);
      canvas.setPointerCapture(event.pointerId);
      requestPaint();
    };

    const onPointerMove = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (!active || active.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendCapturedPoints(active.stroke, event);
      requestPaint();
    };

    const onPointerUp = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (!active || active.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendCapturedPoints(active.stroke, event);
      activeStrokeRef.current = null;
      completedStrokesRef.current.push(active.stroke);
      releaseCapture(event.pointerId);
      appendCompletedInk(active.stroke);
      propsRef.current.onActivePointerChange?.(false);
      propsRef.current.onStrokeComplete?.(
        inkStats(completedStrokesRef.current),
      );
      requestPaint();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        event.preventDefault();
        cancelActiveStroke("pointercancel");
      }
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        cancelActiveStroke("lost-capture");
      }
    };

    const suppressDefault = (event: Event) => event.preventDefault();
    const onOrientationChange = () => {
      cancelActiveStroke("orientation");
      if (orientationFrame !== null) {
        window.cancelAnimationFrame(orientationFrame);
      }
      orientationFrame = window.requestAnimationFrame(() => {
        orientationFrame = null;
        resizeSurface();
      });
    };

    clearRef.current = () => {
      cancelActiveStroke("disabled", false);
      completedStrokesRef.current.length = 0;
      latestPointTimeRef.current = null;
      if (metrics) {
        canonicalSurface = {
          width: metrics.logicalWidth,
          height: metrics.logicalHeight,
        };
        viewportTransform = resizeTransform(canonicalSurface, canonicalSurface);
      }
      rebuildCompletedInk();
      propsRef.current.onClear?.();
      requestPaint();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onLostPointerCapture);
    canvas.addEventListener("contextmenu", suppressDefault);
    canvas.addEventListener("dragstart", suppressDefault);
    canvas.addEventListener("selectstart", suppressDefault);
    window.addEventListener("resize", resizeSurface);
    window.addEventListener("orientationchange", onOrientationChange);

    const resizeObserver = new ResizeObserver(resizeSurface);
    resizeObserver.observe(canvas);
    const stopWatchingDevicePixelRatio = watchDevicePixelRatio(
      window,
      resizeSurface,
    );
    resizeSurface();

    return () => {
      clearRef.current = () => undefined;
      cancelRef.current = () => undefined;
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (orientationFrame !== null) {
        window.cancelAnimationFrame(orientationFrame);
      }
      stopWatchingDevicePixelRatio();
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("contextmenu", suppressDefault);
      canvas.removeEventListener("dragstart", suppressDefault);
      canvas.removeEventListener("selectstart", suppressDefault);
      window.removeEventListener("resize", resizeSurface);
      window.removeEventListener("orientationchange", onOrientationChange);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`ink-canvas ${className}`.trim()}
      aria-label="Handwriting surface. Write a number from zero through 255."
      aria-describedby="ink-instructions"
      aria-disabled={!enabled}
    />
  );
});
