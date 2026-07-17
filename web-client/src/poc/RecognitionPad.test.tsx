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
      onClear?: () => void;
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    const active = React.useRef(false);
    const latest = React.useRef<number | null>(null);
    const strokes = React.useRef(0);
    React.useImperativeHandle(ref, () => ({
      isPointerActive: () => active.current,
      getLatestPointTime: () => latest.current,
      getStats: () => ({
        strokeCount: strokes.current,
        pointCount: strokes.current * 4,
      }),
      getStrokes: () => [],
      rasterize: () => ({
        data: new Float32Array(128 * 32),
        shape: [1, 1, 32, 128],
        width: 128,
        height: 32,
        geometry: {},
        preprocessingVersion: "digits-model-input-v1",
      }),
      clear: () => {
        strokes.current = 0;
        latest.current = null;
        props.onClear?.();
      },
    }));
    return (
      <button
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

function result(revision: number): Recognition {
  return {
    requestId: revision,
    revision,
    text: "5",
    confidence: 1,
    alternatives: [{ text: "5", score: -1 }],
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

function mockRuntime() {
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
      result(requestRevision),
    ),
    dispose: vi.fn(),
  };
  return { runtime, invalidations };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
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
    expect(container.querySelector("output")?.textContent).toBe("5");

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
    act(() => clear?.click());
    expect(invalidations).toEqual([1, 2]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_EFFECT_MS);
    });
    expect(container.querySelector("main")?.dataset.inputState).toBe("empty");
    expect(draw?.disabled).toBe(false);

    act(() => draw?.click());
    expect(invalidations).toEqual([1, 2, 3]);
    await act(async () => {
      root.unmount();
    });
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });
});
