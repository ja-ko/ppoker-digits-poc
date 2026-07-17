import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InkPadHandle } from "../InkPad";
import { PREPROCESSING_CONFIG } from "../ink/rasterize";
import type { RasterizedInk } from "../ink/rasterize";
import type {
  Recognition,
  RecognitionInput,
  RecognizerStatus,
} from "../recognition/types";
import {
  BASE_QUIET_MS,
  CLEAR_EFFECT_MS,
  COMMIT_EFFECT_MS,
  DISSIPATION_EFFECT_MS,
  effectDurations,
  initialFlowDiagnostics,
  PREFIX_COMMIT_MS,
  RecognitionFlow,
  REJECTION_DEADLINE_MS,
  REJECTION_EFFECT_MS,
} from "./recognition-flow";
import type { FlowDiagnostics, RecognitionRuntime } from "./recognition-flow";
import { initialVoteInputState, voteInputReducer } from "./recognition-state";
import type { VoteInputEvent, VoteInputState } from "./recognition-state";

const readyStatus: RecognizerStatus = {
  readiness: "ready",
  progress: 1,
  status: "Recognizer ready",
  metadataReady: true,
  modelReady: true,
};

function recognition(
  text: string,
  confidence = 0.99,
  revision = 1,
): Recognition {
  return {
    requestId: 1,
    revision,
    text,
    confidence,
    alternatives: [
      { text, score: -1 },
      { text: "8", score: -4 },
    ],
    inferenceMs: 2,
    diagnostics: {
      greedyText: text,
      topScore: -1,
      secondScore: -4,
      margin: 3,
      rawThreshold: 2,
      confidenceThreshold: 0.9,
      thresholdPassed: confidence >= 0.9,
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

function raster(): RasterizedInk {
  return {
    data: new Float32Array(128 * 32),
    shape: [1, 1, 32, 128],
    width: 128,
    height: 32,
    geometry: {
      sourceBounds: {
        minX: 0,
        minY: 0,
        maxX: 20,
        maxY: 30,
        width: 20,
        height: 30,
      },
      paddedBounds: {
        minX: -2,
        minY: -2,
        maxX: 22,
        maxY: 32,
        width: 24,
        height: 34,
      },
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    },
    preprocessingVersion: PREPROCESSING_CONFIG.version,
  };
}

interface Harness {
  flow: RecognitionFlow;
  runtime: RecognitionRuntime;
  get state(): VoteInputState;
  get diagnostics(): FlowDiagnostics;
  invalidations: number[];
  recognizeCalls: Array<{ input: RecognitionInput; revision: number }>;
  retry: ReturnType<typeof vi.fn>;
  ink: {
    active: boolean;
    latest: number | null;
    strokes: number;
    points: number;
    raster: RasterizedInk | null;
    rasterError: Error | null;
    clears: number;
    restores: number;
  };
  setDeck(deck: readonly number[]): void;
  setThreshold(threshold: number): void;
  setReducedMotion(reduced: boolean): void;
  setStatus(status: RecognizerStatus): void;
  setRecognition(
    handler: (
      input: RecognitionInput,
      revision: number,
    ) => Promise<Recognition>,
  ): void;
  draw(latest?: number): void;
}

const activeFlows: RecognitionFlow[] = [];

function createHarness(
  deck: readonly number[] = [1, 2, 3, 5, 8, 13],
  initialReducedMotion = false,
): Harness {
  let state = initialVoteInputState;
  let status = readyStatus;
  let numericDeck = deck;
  let confidenceThreshold = 0.9;
  let reducedMotion = initialReducedMotion;
  let diagnostics = initialFlowDiagnostics;
  let recognizeHandler = async (_input: RecognitionInput, revision: number) =>
    recognition("5", 0.99, revision);
  const invalidations: number[] = [];
  const recognizeCalls: Array<{ input: RecognitionInput; revision: number }> =
    [];
  const retry = vi.fn();
  const ink = {
    active: false,
    latest: 0 as number | null,
    strokes: 1,
    points: 4,
    raster: raster() as RasterizedInk | null,
    rasterError: null as Error | null,
    clears: 0,
    restores: 0,
  };
  let revision = 0;
  const runtime: RecognitionRuntime = {
    get status() {
      return status;
    },
    get revision() {
      return revision;
    },
    subscribe: () => () => undefined,
    invalidate: (next = revision + 1) => {
      revision = next;
      invalidations.push(next);
      return revision;
    },
    retry,
    recognize: (input, requestRevision) => {
      recognizeCalls.push({ input, revision: requestRevision });
      return recognizeHandler(input, requestRevision);
    },
    dispose: vi.fn(),
  };
  const inkHandle: InkPadHandle = {
    isPointerActive: () => ink.active,
    getLatestPointTime: () => ink.latest,
    getStats: () => ({ strokeCount: ink.strokes, pointCount: ink.points }),
    getStrokes: () => [],
    getVisualBounds: () => null,
    getCanonicalInkLocus: () => null,
    rasterize: () => {
      if (ink.rasterError) {
        throw ink.rasterError;
      }
      return ink.raster;
    },
    restoreVectorInk: () => {
      ink.restores += 1;
    },
    focus: vi.fn(),
    clear: () => {
      ink.clears += 1;
      ink.strokes = 0;
      ink.points = 0;
      ink.latest = null;
    },
  };
  const flow = new RecognitionFlow({
    getState: () => state,
    dispatch: (event: VoteInputEvent) => {
      state = voteInputReducer(state, event);
    },
    getRecognizerStatus: () => status,
    getConfidenceThreshold: () => confidenceThreshold,
    getNumericDeck: () => numericDeck,
    getInk: () => inkHandle,
    getReducedMotion: () => reducedMotion,
    onDiagnostics: (patch) => {
      diagnostics = { ...diagnostics, ...patch };
    },
    now: () => Date.now(),
  });
  flow.setRuntime(runtime);
  activeFlows.push(flow);

  return {
    flow,
    runtime,
    get state() {
      return state;
    },
    get diagnostics() {
      return diagnostics;
    },
    invalidations,
    recognizeCalls,
    retry,
    ink,
    setDeck(next) {
      numericDeck = next;
      flow.recognitionConfigurationChanged();
    },
    setThreshold(next) {
      confidenceThreshold = next;
      flow.recognitionConfigurationChanged();
    },
    setReducedMotion(next) {
      reducedMotion = next;
    },
    setStatus(next) {
      status = next;
      flow.recognizerStatusChanged(next);
    },
    setRecognition(handler) {
      recognizeHandler = handler;
    },
    draw(latest = 0) {
      ink.latest = latest;
      ink.strokes = Math.max(1, ink.strokes);
      ink.points = Math.max(4, ink.points);
      flow.pointerAccepted();
      flow.strokeCompleted();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const flow of activeFlows.splice(0)) {
    flow.dispose();
  }
  vi.useRealTimers();
});

describe("recognition timing", () => {
  it("starts inference at 675 ms from the latest point and commits a valid non-prefix", async () => {
    const harness = createHarness();
    harness.draw();
    expect(harness.state.status).toBe("settling");
    expect(harness.diagnostics.timerReason).toBe("inference-wait");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS - 1);
    expect(harness.recognizeCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recognizeCalls).toHaveLength(1);
    expect(harness.state).toMatchObject({ status: "committing", value: 5 });
    expect(harness.diagnostics.recognition?.text).toBe("5");

    await vi.advanceTimersByTimeAsync(COMMIT_EFFECT_MS);
    expect(harness.state).toMatchObject({ status: "committed", value: 5 });
    expect(harness.ink.clears).toBe(1);
  });

  it("waits until 1000 ms for an exact card that prefixes a longer card", async () => {
    const harness = createHarness([1, 13]);
    harness.setRecognition(async (_input, revision) =>
      recognition("1", 0.99, revision),
    );
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state.status).toBe("settling");
    expect(harness.diagnostics.timerReason).toBe("prefix-commit");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PREFIX_COMMIT_MS - BASE_QUIET_MS - 1);
    expect(harness.state.status).toBe("settling");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state).toMatchObject({ status: "committing", value: 1 });
  });

  it("reclassifies [1,13] to proper-prefix [13] and replaces the deadline", async () => {
    const harness = createHarness([1, 13]);
    harness.setRecognition(async (_input, revision) =>
      recognition("1", 0.99, revision),
    );
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.diagnostics.timerReason).toBe("prefix-commit");

    await vi.advanceTimersByTimeAsync(100);
    harness.setDeck([13]);
    expect(harness.diagnostics.timerReason).toBe("incomplete");
    expect(harness.diagnostics.timerDeadline).toBe(REJECTION_DEADLINE_MS);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(PREFIX_COMMIT_MS - 775);
    expect(harness.state.status).toBe("settling");
    await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS - PREFIX_COMMIT_MS);
    expect(harness.state).toMatchObject({
      status: "rejecting",
      rejection: "incomplete",
    });
  });

  it("uses the latest threshold and acts immediately when its deadline has passed", async () => {
    const harness = createHarness([1, 13]);
    harness.setThreshold(0.7);
    harness.setRecognition(async (_input, revision) =>
      recognition("1", 0.8, revision),
    );
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.diagnostics.timerReason).toBe("prefix-commit");

    await vi.advanceTimersByTimeAsync(125);
    harness.setThreshold(0.9);
    expect(harness.diagnostics.timerReason).toBe("unclaimed");
    expect(harness.diagnostics.timerDeadline).toBe(REJECTION_DEADLINE_MS);

    await vi.advanceTimersByTimeAsync(250);
    harness.setThreshold(0.7);
    expect(harness.state).toMatchObject({ status: "committing", value: 1 });
    expect(harness.diagnostics.timerReason).toBe("commit-effect");
    expect(vi.getTimerCount()).toBe(1);
  });

  it("moves one timer between exact, proper-prefix, and invalid dispositions", async () => {
    const harness = createHarness([1, 13]);
    harness.setRecognition(async (_input, revision) =>
      recognition("1", 0.99, revision),
    );
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.diagnostics.timerReason).toBe("prefix-commit");

    harness.setDeck([13]);
    expect(harness.diagnostics.timerReason).toBe("incomplete");
    expect(vi.getTimerCount()).toBe(1);
    harness.setDeck([2]);
    expect(harness.diagnostics.timerReason).toBe("invalid");
    expect(vi.getTimerCount()).toBe(1);
    harness.setDeck([1, 13]);
    expect(harness.diagnostics.timerReason).toBe("prefix-commit");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(PREFIX_COMMIT_MS - BASE_QUIET_MS);
    expect(harness.state).toMatchObject({ status: "committing", value: 1 });
  });

  it.each([
    ["proper prefix", [13], "1", 0.99, "incomplete"],
    ["invalid deck value", [1, 5], "4", 0.99, "invalid"],
    ["low confidence", [5], "5", 0.5, "unclaimed"],
    ["noncanonical", [1], "01", 0.99, "unclaimed"],
    ["empty text", [1], "", 0.99, "unclaimed"],
  ])(
    "waits until 1100 ms for %s",
    async (_name, deck, text, confidence, rejection) => {
      const harness = createHarness(deck as number[]);
      harness.setRecognition(async (_input, revision) =>
        recognition(text as string, confidence as number, revision),
      );
      harness.draw();
      await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS - 1);
      expect(harness.state.status).toBe("settling");
      expect(harness.ink.clears).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(harness.state).toMatchObject({
        status: "rejecting",
        rejection,
      });
      expect(harness.ink.clears).toBe(0);
    },
  );

  it("uses a shorter soft dissipation than the invalid shake", async () => {
    const invalid = createHarness([5]);
    invalid.setRecognition(async (_input, revision) =>
      recognition("4", 0.99, revision),
    );
    invalid.draw();
    await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS);
    expect(invalid.state).toMatchObject({
      status: "rejecting",
      rejection: "invalid",
    });
    await vi.advanceTimersByTimeAsync(DISSIPATION_EFFECT_MS);
    expect(invalid.state.status).toBe("rejecting");
    await vi.advanceTimersByTimeAsync(
      REJECTION_EFFECT_MS - DISSIPATION_EFFECT_MS,
    );
    expect(invalid.state.status).toBe("empty");

    vi.setSystemTime(0);
    const unclaimed = createHarness([5]);
    unclaimed.setRecognition(async (_input, revision) =>
      recognition("5", 0.5, revision),
    );
    unclaimed.draw();
    await vi.advanceTimersByTimeAsync(
      REJECTION_DEADLINE_MS + DISSIPATION_EFFECT_MS,
    );
    expect(unclaimed.state.status).toBe("empty");
  });

  it("uses deterministic opacity-only timing for reduced motion", async () => {
    const harness = createHarness([5], true);
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state.status).toBe("committing");

    const reduced = effectDurations(true);
    await vi.advanceTimersByTimeAsync(reduced.commit - 1);
    expect(harness.state.status).toBe("committing");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.state.status).toBe("committed");

    harness.flow.clear();
    await vi.advanceTimersByTimeAsync(reduced.clear);
    expect(harness.state.status).toBe("empty");
  });

  it("keeps full motion timing when preference changes to reduced mid-effect", async () => {
    const harness = createHarness([5], false);
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state).toMatchObject({
      status: "committing",
      effectMotion: "full",
    });

    harness.setReducedMotion(true);
    await vi.advanceTimersByTimeAsync(effectDurations(true).commit);
    expect(harness.state.status).toBe("committing");
    await vi.advanceTimersByTimeAsync(
      COMMIT_EFFECT_MS - effectDurations(true).commit,
    );
    expect(harness.state.status).toBe("committed");

    harness.flow.clear();
    expect(harness.state.effectMotion).toBe("reduced");
    await vi.advanceTimersByTimeAsync(effectDurations(true).clear);
    expect(harness.state.status).toBe("empty");
  });

  it("keeps reduced timing when preference changes to full mid-effect", async () => {
    const harness = createHarness([5], true);
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state).toMatchObject({
      status: "committing",
      effectMotion: "reduced",
    });

    harness.setReducedMotion(false);
    await vi.advanceTimersByTimeAsync(effectDurations(true).commit);
    expect(harness.state.status).toBe("committed");

    harness.flow.clear();
    expect(harness.state.effectMotion).toBe("full");
    await vi.advanceTimersByTimeAsync(effectDurations(true).clear);
    expect(harness.state.status).toBe("clearing");
    await vi.advanceTimersByTimeAsync(
      CLEAR_EFFECT_MS - effectDurations(true).clear,
    );
    expect(harness.state.status).toBe("empty");
  });

  it("treats a trivially small raster as unclaimed without invoking the model", async () => {
    const harness = createHarness();
    harness.ink.raster = null;
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.recognizeCalls).toHaveLength(0);
    expect(harness.diagnostics.timerReason).toBe("unclaimed");
    await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS - BASE_QUIET_MS);
    expect(harness.state).toMatchObject({
      status: "rejecting",
      rejection: "unclaimed",
    });
  });

  it.each([
    ["prefix commit", [1, 13], "1", "committing"],
    ["invalid rejection", [1, 5], "4", "rejecting"],
  ])(
    "acts immediately on a delayed %s result only while current",
    async (_name, deck, text, expectedStatus) => {
      let resolve: ((value: Recognition) => void) | undefined;
      const harness = createHarness(deck as number[]);
      harness.setRecognition(
        (_input, revision) =>
          new Promise((done) => {
            resolve = (value) => done({ ...value, revision });
          }),
      );
      harness.draw();
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
      await vi.advanceTimersByTimeAsync(
        REJECTION_DEADLINE_MS - BASE_QUIET_MS + 100,
      );
      resolve?.(recognition(text as string));
      await Promise.resolve();
      expect(harness.state.status).toBe(expectedStatus);
    },
  );
});

describe("cancellation and guards", () => {
  it("invalidates synchronously and cancels settling on every accepted pointerdown", () => {
    const harness = createHarness();
    harness.draw();
    expect(vi.getTimerCount()).toBe(1);
    harness.flow.pointerAccepted();
    expect(harness.invalidations).toEqual([1, 2]);
    expect(harness.state).toMatchObject({ status: "drawing", revision: 2 });
    expect(vi.getTimerCount()).toBe(0);
    expect(harness.ink.clears).toBe(0);
    expect(harness.ink.restores).toBe(2);
  });

  it.each(["committing", "rejecting"])(
    "restores drawing and preserves vectors when pointerdown cancels %s",
    async (status) => {
      const harness = createHarness();
      if (status === "rejecting") {
        harness.setRecognition(async (_input, revision) =>
          recognition("4", 0.99, revision),
        );
      }
      harness.draw();
      await vi.advanceTimersByTimeAsync(
        status === "committing" ? BASE_QUIET_MS : REJECTION_DEADLINE_MS,
      );
      expect(harness.state.status).toBe(status);
      harness.flow.pointerAccepted();
      expect(harness.state.status).toBe("drawing");
      expect(harness.ink.clears).toBe(0);
      expect(harness.ink.restores).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("cancels a partial stroke without recognizing preserved completed vectors", async () => {
    const harness = createHarness();
    harness.draw();
    harness.flow.pointerAccepted();
    harness.flow.strokeCancelled();
    await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS);
    expect(harness.state.status).toBe("drawing");
    expect(harness.recognizeCalls).toHaveLength(0);
    expect(harness.ink.clears).toBe(0);
  });

  it("ignores stale inference after a newer pointer revision", async () => {
    let resolve: ((recognition: Recognition) => void) | undefined;
    const harness = createHarness();
    harness.setRecognition(
      (_input, revision) =>
        new Promise((done) => {
          resolve = (value) => done({ ...value, revision });
        }),
    );
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    harness.flow.pointerAccepted();
    resolve?.(recognition("5"));
    await Promise.resolve();
    expect(harness.state).toMatchObject({ status: "drawing", revision: 2 });
    expect(harness.ink.clears).toBe(0);
  });

  it("ignores a response carrying the wrong revision", async () => {
    const harness = createHarness();
    harness.setRecognition(async () => recognition("5", 0.99, 99));
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state.status).toBe("settling");
    expect(harness.ink.clears).toBe(0);
  });

  it("never recognizes or acts while a pointer is active", async () => {
    const harness = createHarness();
    harness.draw();
    harness.ink.active = true;
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.recognizeCalls).toHaveLength(0);
    expect(harness.state.status).toBe("settling");

    harness.ink.active = false;
    harness.flow.pointerAccepted();
    harness.ink.latest = BASE_QUIET_MS;
    harness.flow.strokeCompleted();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.recognizeCalls).toHaveLength(1);
  });
});

describe("clear and runtime failures", () => {
  it("increments clear revision and returns a committed pad to reusable empty", async () => {
    const harness = createHarness();
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS + COMMIT_EFFECT_MS);
    expect(harness.state.status).toBe("committed");

    expect(harness.flow.clear()).toBe(2);
    expect(harness.state).toMatchObject({
      status: "clearing",
      revision: 2,
      value: 5,
    });
    expect(harness.invalidations).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(CLEAR_EFFECT_MS);
    expect(harness.state).toEqual({ ...initialVoteInputState, revision: 2 });

    harness.ink.strokes = 1;
    harness.ink.points = 4;
    harness.ink.latest = Date.now();
    harness.ink.raster = raster();
    harness.flow.pointerAccepted();
    harness.flow.strokeCompleted();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state).toMatchObject({ status: "committing", revision: 3 });
  });

  it("revision-guards clear completion when drawing resumes", async () => {
    const harness = createHarness();
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS + COMMIT_EFFECT_MS);
    harness.flow.clear();
    expect(harness.state).toMatchObject({ status: "clearing", revision: 2 });

    harness.flow.pointerAccepted();
    expect(harness.state).toMatchObject({ status: "drawing", revision: 3 });
    await vi.advanceTimersByTimeAsync(CLEAR_EFFECT_MS);
    expect(harness.state).toMatchObject({ status: "drawing", revision: 3 });
  });

  it("preserves ink on inference failure and retries after runtime recovery", async () => {
    const harness = createHarness();
    let attempts = 0;
    harness.setRecognition(async (_input, revision) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("session failed");
      }
      return recognition("5", 0.99, revision);
    });
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    expect(harness.state).toMatchObject({
      status: "drawing",
      inferenceError: "session failed",
    });
    expect(harness.ink.clears).toBe(0);

    harness.flow.retry();
    expect(harness.retry).toHaveBeenCalledOnce();
    harness.setStatus({
      ...readyStatus,
      readiness: "loading",
      progress: 0,
      status: "Recovering",
    });
    harness.setStatus(readyStatus);
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(harness.state).toMatchObject({ status: "committing", value: 5 });
    expect(harness.ink.clears).toBe(0);
  });

  it.each(["rasterize", "recognize"])(
    "preserves ink and leaves no timer after synchronous %s failure",
    async (source) => {
      const harness = createHarness();
      if (source === "rasterize") {
        harness.ink.rasterError = new Error("raster failed");
      } else {
        harness.setRecognition(() => {
          throw new Error("request failed");
        });
      }
      harness.draw();
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
      expect(harness.state).toMatchObject({
        status: "drawing",
        inferenceError:
          source === "rasterize" ? "raster failed" : "request failed",
      });
      expect(harness.ink.clears).toBe(0);
      expect(harness.diagnostics.inferencePending).toBe(false);
      expect(harness.diagnostics.timerReason).toBeNull();
      expect(vi.getTimerCount()).toBe(0);

      harness.ink.rasterError = null;
      harness.setRecognition(async (_input, revision) =>
        recognition("5", 0.99, revision),
      );
      harness.ink.latest = Date.now();
      harness.flow.pointerAccepted();
      harness.flow.strokeCompleted();
      await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
      expect(harness.state).toMatchObject({ status: "committing", value: 5 });
    },
  );

  it("never commits or rejects when readiness fails during inference", async () => {
    const harness = createHarness();
    harness.setRecognition(() => new Promise(() => undefined));
    harness.draw();
    await vi.advanceTimersByTimeAsync(BASE_QUIET_MS);
    harness.setStatus({
      readiness: "failed",
      progress: 0,
      status: "worker crashed",
      metadataReady: false,
      modelReady: false,
      error: {
        code: "worker_failed",
        message: "worker crashed",
        stage: "worker",
        recoverable: true,
      },
    });
    await vi.advanceTimersByTimeAsync(REJECTION_DEADLINE_MS);
    expect(harness.state.status).toBe("drawing");
    expect(harness.ink.clears).toBe(0);
  });
});
