// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recognition, RecognizerStatus } from "../recognition/types";
import type { RecognitionRuntime } from "./recognition-flow";
import {
  BASE_QUIET_MS,
  CLEAR_EFFECT_MS,
  COMMIT_EFFECT_MS,
} from "./recognition-flow";

let motionPreference = false;
const motionListeners = new Set<() => void>();
const inkMock = vi.hoisted(() => ({
  surface: { width: 320, height: 640 },
  surfaceListener: null as
    null | ((size: { width: number; height: number }) => void),
}));

function setMotionPreference(reduced: boolean): void {
  motionPreference = reduced;
  for (const listener of motionListeners) {
    listener();
  }
}

vi.mock("../InkPad", async () => {
  const React = await import("react");
  const InkPad = React.forwardRef(function MockInkPad(
    props: {
      enabled?: boolean;
      onPointerAccepted?: () => void;
      onActivePointerChange?: (active: boolean) => void;
      onStrokeComplete?: (stats: {
        strokeCount: number;
        pointCount: number;
      }) => void;
      onSurfaceChange?: (size: { width: number; height: number }) => void;
      onClear?: () => void;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    const { onSurfaceChange } = props;
    const surfaceRef = React.useRef<HTMLButtonElement>(null);
    const active = React.useRef(false);
    const latest = React.useRef<number | null>(null);
    const strokes = React.useRef(0);
    React.useLayoutEffect(() => {
      inkMock.surfaceListener = onSurfaceChange ?? null;
      onSurfaceChange?.(inkMock.surface);
      return () => {
        if (inkMock.surfaceListener === onSurfaceChange) {
          inkMock.surfaceListener = null;
        }
      };
    }, [onSurfaceChange]);
    React.useImperativeHandle(ref, () => ({
      isPointerActive: () => active.current,
      getLatestPointTime: () => latest.current,
      getStats: () => ({
        strokeCount: strokes.current,
        pointCount: strokes.current * 4,
      }),
      getStrokes: () => [],
      getVisualBounds: () => ({
        minX: 30,
        minY: 120,
        maxX: 130,
        maxY: 320,
        width: 100,
        height: 200,
        centerX: 80,
        centerY: 220,
        surfaceWidth: 320,
        surfaceHeight: 640,
      }),
      getCanonicalInkLocus: () => ({
        center: { x: 80, y: 220 },
        coordinateSpace: { width: 320, height: 640 },
      }),
      rasterize: () => ({
        data: new Float32Array(128 * 32),
        shape: [1, 1, 32, 128],
        width: 128,
        height: 32,
        geometry: {},
        preprocessingVersion: "digits-model-input-v1",
      }),
      restoreVectorInk: vi.fn(),
      focus: () => surfaceRef.current?.focus({ preventScroll: true }),
      clear: () => {
        strokes.current = 0;
        latest.current = null;
        props.onClear?.();
      },
    }));
    return (
      <button
        ref={surfaceRef}
        type="button"
        aria-label="Draw test stroke"
        disabled={!props.enabled}
        onClick={() => {
          props.onPointerAccepted?.();
          active.current = true;
          props.onActivePointerChange?.(true);
          latest.current = Date.now();
          strokes.current += 1;
          active.current = false;
          props.onActivePointerChange?.(false);
          props.onStrokeComplete?.({
            strokeCount: strokes.current,
            pointCount: strokes.current * 4,
          });
        }}
      >
        draw
      </button>
    );
  });
  return { InkPad };
});

import { RecognitionPad } from "./RecognitionPad";

const ready: RecognizerStatus = {
  readiness: "ready",
  progress: 1,
  status: "Recognizer ready",
  metadataReady: true,
  modelReady: true,
};

function result(revision: number, text = "5", confidence = 1): Recognition {
  return {
    requestId: revision,
    revision,
    text,
    confidence,
    alternatives: [{ text, score: -1 }],
    inferenceMs: 2,
    diagnostics: {
      greedyText: "5",
      topScore: -1,
      secondScore: -5,
      margin: 4,
      rawThreshold: 2,
      confidenceThreshold: 0.9,
      thresholdPassed: true,
      outputShape: [1, 63, 11],
      timing: {
        rasterizationMs: 0,
        inferenceMs: 2,
        decodeMs: 1,
        workerMs: 3,
        workerRoundTripMs: 4,
      },
    },
  };
}

function mockRuntime(text = "5", confidence = 1) {
  let revision = 0;
  const invalidations: number[] = [];
  const runtime: RecognitionRuntime = {
    status: ready,
    get revision() {
      return revision;
    },
    subscribe(listener) {
      listener(ready);
      return () => undefined;
    },
    invalidate(next = revision + 1) {
      revision = next;
      invalidations.push(next);
      return revision;
    },
    retry: vi.fn(),
    recognize: vi.fn(async (_input, requestRevision) =>
      result(requestRevision, text, confidence),
    ),
    dispose: vi.fn(),
  };
  return { runtime, invalidations };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  motionPreference = false;
  motionListeners.clear();
  inkMock.surface = { width: 320, height: 640 };
  inkMock.surfaceListener = null;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      get matches() {
        return motionPreference;
      },
      addEventListener: (_type: string, listener: () => void) => {
        motionListeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        motionListeners.delete(listener);
      },
    }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    }),
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("RecognitionPad integration", () => {
  it("connects accepted input through mocked recognition, commit, clear, and reuse", async () => {
    const { runtime, invalidations } = mockRuntime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RecognitionPad
          createRuntime={() => runtime}
          diagnosticsEnabled={false}
        />,
      );
    });

    const draw = container.querySelector<HTMLButtonElement>(
      '[aria-label="Draw test stroke"]',
    );
    expect(draw?.disabled).toBe(false);
    act(() => draw?.click());
    expect(invalidations).toEqual([1]);
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "settling",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    });
    expect(runtime.recognize).toHaveBeenCalledOnce();
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "committing",
    );
    expect(container.querySelector("main")?.dataset.inkEffect).toBe("resolve");
    expect(container.querySelector("main")?.dataset.motion).toBe("full");
    expect(
      container
        .querySelector<HTMLElement>("main")
        ?.style.getPropertyValue("--ink-center-x"),
    ).toBe("80px");
    expect(
      container
        .querySelector<HTMLElement>("main")
        ?.style.getPropertyValue("--result-center-y"),
    ).toBe("220px");
    expect(container.querySelector("output")?.textContent).toBe("5");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Clear surface",
      ),
    ).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMMIT_EFFECT_MS);
    });
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "committed",
    );
    expect(draw?.disabled).toBe(true);
    const liveStatus = container.querySelector(".stroke-status");
    expect(liveStatus?.getAttribute("aria-live")).toBe("polite");
    expect(liveStatus?.textContent).toContain(
      "Vote 5 committed. Drawing locked.",
    );
    expect(liveStatus?.textContent).not.toContain("Surface ready");

    const clear = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear and try again",
    );
    clear?.focus();
    act(() => clear?.click());
    expect(invalidations).toEqual([1, 2]);
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "clearing",
    );
    expect(container.querySelector("output")?.textContent).toBe("5");
    expect(
      container.querySelector<HTMLButtonElement>(".result-clear")?.disabled,
    ).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_EFFECT_MS);
    });
    expect(container.querySelector("main")?.dataset.inputState).toBe("empty");
    expect(draw?.disabled).toBe(false);
    expect(document.activeElement).toBe(draw);

    act(() => draw?.click());
    expect(invalidations).toEqual([1, 2, 3]);
    await act(async () => {
      root.unmount();
    });
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["invalid", "4", 1, "invalid"],
    ["low confidence", "5", 0.1, "dissipate"],
    ["noncanonical", "01", 1, "dissipate"],
  ])(
    "exposes the semantic %s rejection hook without a candidate",
    async (_name, text, confidence, effect) => {
      const { runtime } = mockRuntime(text as string, confidence as number);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <RecognitionPad
            createRuntime={() => runtime}
            diagnosticsEnabled={false}
          />,
        );
      });
      act(() =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Draw test stroke"]')
          ?.click(),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100);
      });
      const main = container.querySelector("main");
      expect(main?.dataset.inputState).toBe("rejecting");
      expect(main?.dataset.inkEffect).toBe(effect);
      expect(container.querySelector("output")).toBeNull();
      await act(async () => root.unmount());
    },
  );

  it("does not move focus to the surface after a pointer clear", async () => {
    const { runtime } = mockRuntime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RecognitionPad
          createRuntime={() => runtime}
          diagnosticsEnabled={false}
        />,
      );
    });
    const draw = container.querySelector<HTMLButtonElement>(
      '[aria-label="Draw test stroke"]',
    );
    act(() => draw?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS + COMMIT_EFFECT_MS);
    });
    const clear = container.querySelector<HTMLButtonElement>(".result-clear");
    clear?.focus();
    act(() =>
      clear?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 1 }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_EFFECT_MS);
    });
    expect(document.activeElement).not.toBe(draw);
    await act(async () => root.unmount());
  });

  it("keeps reduced CSS hooks when preference changes to full mid-effect", async () => {
    motionPreference = true;
    const { runtime } = mockRuntime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RecognitionPad
          createRuntime={() => runtime}
          diagnosticsEnabled={false}
        />,
      );
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Draw test stroke"]')
        ?.click(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    });
    expect(container.querySelector("main")?.dataset.motion).toBe("reduced");
    expect(
      container
        .querySelector<HTMLElement>("main")
        ?.style.getPropertyValue("--commit-effect-ms"),
    ).toBe("90ms");
    act(() => setMotionPreference(false));
    expect(container.querySelector("main")?.dataset.motion).toBe("reduced");
    expect(
      container
        .querySelector<HTMLElement>("main")
        ?.style.getPropertyValue("--commit-effect-ms"),
    ).toBe("90ms");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90);
    });
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "committed",
    );
    await act(async () => root.unmount());
  });

  it("keeps full CSS hooks when preference changes to reduced mid-effect", async () => {
    const { runtime } = mockRuntime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RecognitionPad
          createRuntime={() => runtime}
          diagnosticsEnabled={false}
        />,
      );
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Draw test stroke"]')
        ?.click(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    });
    expect(container.querySelector("main")?.dataset.motion).toBe("full");
    act(() => setMotionPreference(true));
    expect(container.querySelector("main")?.dataset.motion).toBe("full");
    expect(
      container
        .querySelector<HTMLElement>("main")
        ?.style.getPropertyValue("--commit-effect-ms"),
    ).toBe(`${COMMIT_EFFECT_MS}ms`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90);
    });
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "committing",
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMMIT_EFFECT_MS - 90);
      root.unmount();
    });
  });

  it("keeps diagnostics compact until the inspector is explicitly opened", async () => {
    const { runtime } = mockRuntime();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <RecognitionPad
          createRuntime={() => runtime}
          diagnosticsEnabled={true}
        />,
      );
    });
    const diagnostics = container.querySelector<HTMLElement>(".diagnostics");
    const inspector = container.querySelector<HTMLElement>(
      ".diagnostics-inspector",
    );
    expect(diagnostics?.dataset.expanded).toBe("false");
    expect(inspector?.hidden).toBe(true);

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Draw test stroke"]')
        ?.click(),
    );
    expect(container.querySelector("main")?.dataset.inputState).toBe(
      "settling",
    );
    act(() =>
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Inspect")
        ?.click(),
    );
    expect(diagnostics?.dataset.expanded).toBe("true");
    expect(inspector?.hidden).toBe(false);
    expect(
      container.querySelector<HTMLInputElement>(
        '.diagnostics-control input[type="number"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("Run benchmark");
    await act(async () => root.unmount());
  });
});
