import { useEffect, useRef, useState } from "react";

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
import { PREPROCESSING_CONFIG, rasterizeInk } from "./ink/rasterize";
import {
  clearInk,
  drawInk,
  normalizedDevicePixelRatio,
  renderInk,
  resizeCanvas,
  watchDevicePixelRatio,
} from "./ink/render";
import type { CanvasMetrics, VisibleInkStyle } from "./ink/render";
import type { InkStroke } from "./ink/types";

interface ActiveStroke {
  pointerId: number;
  stroke: InkStroke;
}

function paintPreview(
  canvas: HTMLCanvasElement,
  data: Float32Array | null,
): void {
  const { width, height } = PREPROCESSING_CONFIG;
  if (canvas.width !== width) {
    canvas.width = width;
  }
  if (canvas.height !== height) {
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const pixels = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.round((data?.[index] ?? 0) * 255);
    const pixelIndex = index * 4;
    pixels.data[pixelIndex] = value;
    pixels.data[pixelIndex + 1] = value;
    pixels.data[pixelIndex + 2] = value;
    pixels.data[pixelIndex + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
}

export function InkPad() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const completedStrokesRef = useRef<InkStroke[]>([]);
  const activeStrokeRef = useRef<ActiveStroke | null>(null);
  const clearRef = useRef<() => void>(() => undefined);
  const [strokeCount, setStrokeCount] = useState(0);
  const showPreview =
    import.meta.env.DEV ||
    new URLSearchParams(window.location.search).get("preview") === "1";

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

    const refreshPreview = () => {
      if (!previewRef.current) {
        return;
      }
      const raster = rasterizeInk(completedStrokesRef.current);
      paintPreview(previewRef.current, raster?.data ?? null);
    };

    const releaseCapture = (pointerId: number) => {
      if (canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    };

    const cancelActiveStroke = () => {
      const active = activeStrokeRef.current;
      if (!active) {
        return;
      }
      activeStrokeRef.current = null;
      releaseCapture(active.pointerId);
      requestPaint();
    };

    const resizeSurface = () => {
      cancelActiveStroke();
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

    const onPointerDown = (event: PointerEvent) => {
      if (
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
      const stroke: InkStroke = { points: [] };
      appendOrderedPoints(stroke.points, capturedPoints(event));
      activeStrokeRef.current = { pointerId: event.pointerId, stroke };
      canvas.setPointerCapture(event.pointerId);
      requestPaint();
    };

    const onPointerMove = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (!active || active.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendOrderedPoints(active.stroke.points, capturedPoints(event));
      requestPaint();
    };

    const onPointerUp = (event: PointerEvent) => {
      const active = activeStrokeRef.current;
      if (!active || active.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      appendOrderedPoints(active.stroke.points, capturedPoints(event));
      activeStrokeRef.current = null;
      completedStrokesRef.current.push(active.stroke);
      releaseCapture(event.pointerId);
      appendCompletedInk(active.stroke);
      setStrokeCount(completedStrokesRef.current.length);
      refreshPreview();
      requestPaint();
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        event.preventDefault();
        cancelActiveStroke();
      }
    };

    const onLostPointerCapture = (event: PointerEvent) => {
      if (activeStrokeRef.current?.pointerId === event.pointerId) {
        cancelActiveStroke();
      }
    };

    const suppressDefault = (event: Event) => event.preventDefault();
    const onOrientationChange = () => {
      cancelActiveStroke();
      if (orientationFrame !== null) {
        window.cancelAnimationFrame(orientationFrame);
      }
      orientationFrame = window.requestAnimationFrame(() => {
        orientationFrame = null;
        resizeSurface();
      });
    };

    clearRef.current = () => {
      cancelActiveStroke();
      completedStrokesRef.current.length = 0;
      if (metrics) {
        canonicalSurface = {
          width: metrics.logicalWidth,
          height: metrics.logicalHeight,
        };
        viewportTransform = resizeTransform(canonicalSurface, canonicalSurface);
      }
      rebuildCompletedInk();
      setStrokeCount(0);
      refreshPreview();
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
    refreshPreview();

    return () => {
      clearRef.current = () => undefined;
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
    <main className="ink-shell">
      <div className="atmosphere" aria-hidden="true" />
      <div className="writing-guide" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <canvas
        ref={canvasRef}
        className="ink-canvas"
        aria-label="Handwriting surface. Write a number from zero through 255."
        aria-describedby="ink-instructions"
      />

      <header className="ink-header">
        <div className="identity">
          <span className="identity-mark" aria-hidden="true" />
          <span>ppoker / ink study</span>
        </div>
        <div className="range-label">canonical 0-255</div>
        <h1>Write a number.</h1>
        <p id="ink-instructions">
          Use one continuous thought. Add another stroke whenever you need it.
        </p>
      </header>

      {showPreview && (
        <aside
          className="raster-preview"
          aria-label="Recognition raster preview"
        >
          <div>
            <span>model input</span>
            <code>{PREPROCESSING_CONFIG.version}</code>
          </div>
          <canvas
            ref={previewRef}
            role="img"
            aria-label="The exact 128 by 32 recognition raster"
          />
        </aside>
      )}

      <footer className="ink-toolbar">
        <p className="stroke-status" aria-live="polite">
          <span aria-hidden="true" />
          {strokeCount === 0
            ? "Surface ready"
            : `${strokeCount} ${strokeCount === 1 ? "stroke" : "strokes"}`}
        </p>
        <button type="button" onClick={() => clearRef.current()}>
          <span>Clear surface</span>
        </button>
      </footer>
    </main>
  );
}
