// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InkPad } from "./InkPad";
import type { InkPadHandle } from "./InkPad";

function pointerEvent(
  type: "pointerdown" | "pointerup" | "pointercancel",
  x: number,
  y: number,
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
  });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 7 },
    pointerType: { value: "mouse" },
    pressure: { value: 0.5 },
  });
  return event;
}

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const captures = new WeakMap<HTMLCanvasElement, Set<number>>();
  Object.defineProperties(HTMLCanvasElement.prototype, {
    getContext: {
      configurable: true,
      value: () => ({
        arc: vi.fn(),
        beginPath: vi.fn(),
        clearRect: vi.fn(),
        drawImage: vi.fn(),
        fill: vi.fn(),
        moveTo: vi.fn(),
        quadraticCurveTo: vi.fn(),
        restore: vi.fn(),
        save: vi.fn(),
        setTransform: vi.fn(),
        stroke: vi.fn(),
      }),
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 640,
        height: 640,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    },
    hasPointerCapture: {
      configurable: true,
      value(this: HTMLCanvasElement, pointerId: number) {
        return captures.get(this)?.has(pointerId) ?? false;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value(this: HTMLCanvasElement, pointerId: number) {
        captures.get(this)?.delete(pointerId);
      },
    },
    setPointerCapture: {
      configurable: true,
      value(this: HTMLCanvasElement, pointerId: number) {
        let current = captures.get(this);
        if (!current) {
          current = new Set();
          captures.set(this, current);
        }
        current.add(pointerId);
      },
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: vi.fn(() => 1),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("InkPad surface API", () => {
  it("reports accepted desktop input, immutable vectors, rasterization, and reuse", async () => {
    const accepted = vi.fn();
    const activeChanges = vi.fn();
    const completed = vi.fn();
    const cleared = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          onPointerAccepted={accepted}
          onActivePointerChange={activeChanges}
          onStrokeComplete={completed}
          onClear={cleared}
        />,
      );
    });
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();

    act(() => canvas?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    expect(accepted).toHaveBeenCalledOnce();
    expect(ref.current?.isPointerActive()).toBe(true);
    expect(ref.current?.getLatestPointTime()).toBeTypeOf("number");

    act(() => canvas?.dispatchEvent(pointerEvent("pointerup", 120, 230)));
    expect(ref.current?.isPointerActive()).toBe(false);
    expect(activeChanges.mock.calls.map(([active]) => active)).toEqual([
      true,
      false,
    ]);
    expect(completed).toHaveBeenCalledWith({ strokeCount: 1, pointCount: 2 });
    expect(ref.current?.getStats()).toEqual({ strokeCount: 1, pointCount: 2 });
    const strokes = ref.current?.getStrokes();
    expect(Object.isFrozen(strokes)).toBe(true);
    expect(Object.isFrozen(strokes?.[0])).toBe(true);
    expect(Object.isFrozen(strokes?.[0].points)).toBe(true);
    expect(Object.isFrozen(strokes?.[0].points[0])).toBe(true);
    expect(ref.current?.rasterize()).not.toBeNull();

    act(() => ref.current?.clear());
    expect(cleared).toHaveBeenCalledOnce();
    expect(ref.current?.getStats()).toEqual({ strokeCount: 0, pointCount: 0 });
    expect(ref.current?.getLatestPointTime()).toBeNull();
    expect(ref.current?.rasterize()).toBeNull();

    act(() => canvas?.dispatchEvent(pointerEvent("pointerdown", 40, 50)));
    expect(accepted).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });

  it("discards a cancelled partial stroke and ignores input while disabled", async () => {
    const accepted = vi.fn();
    const cancelled = vi.fn();
    const ref = createRef<InkPadHandle>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          onPointerAccepted={accepted}
          onStrokeCancel={cancelled}
        />,
      );
    });
    const canvas = container.querySelector("canvas");
    act(() => canvas?.dispatchEvent(pointerEvent("pointerdown", 20, 30)));
    act(() => canvas?.dispatchEvent(pointerEvent("pointercancel", 40, 60)));
    expect(cancelled).toHaveBeenCalledWith("pointercancel", {
      strokeCount: 0,
      pointCount: 0,
    });
    expect(ref.current?.getStats().strokeCount).toBe(0);

    await act(async () => {
      root.render(
        <InkPad
          ref={ref}
          enabled={false}
          onPointerAccepted={accepted}
          onStrokeCancel={cancelled}
        />,
      );
    });
    act(() => canvas?.dispatchEvent(pointerEvent("pointerdown", 50, 70)));
    expect(accepted).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});
