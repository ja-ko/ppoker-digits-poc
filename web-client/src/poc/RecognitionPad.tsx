import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { InkPad } from "../InkPad";
import type {
  CanonicalInkLocus,
  InkPadHandle,
  InkStats,
  InkSurfaceSize,
} from "../InkPad";
import { fitCoordinateSpace, transformCoordinatePoint } from "../ink/capture";
import { PREPROCESSING_CONFIG } from "../ink/rasterize";
import { RecognitionClient } from "../recognition/client";
import { MODEL_INPUT_SHAPE } from "../recognition/types";
import type { RecognizerStatus } from "../recognition/types";
import { Diagnostics } from "./Diagnostics";
import type { BenchmarkViewState } from "./Diagnostics";
import { benchmarkStats, parseNumericDeck } from "./diagnostics";
import {
  effectDurations,
  initialFlowDiagnostics,
  RecognitionFlow,
} from "./recognition-flow";
import type { FlowDiagnostics, RecognitionRuntime } from "./recognition-flow";
import {
  DEFAULT_NUMERIC_DECK,
  initialRecognizerStatus,
  initialVoteInputState,
  POC_BROWSER_DEFAULT_CONFIDENCE_THRESHOLD,
  rejectionAnimation,
  recognizerReducer,
  voteInputReducer,
} from "./recognition-state";
import type { VoteInputEvent } from "./recognition-state";
import type { VoteInputState } from "./recognition-state";

const EMPTY_INK_STATS: InkStats = { strokeCount: 0, pointCount: 0 };
const BENCHMARK_WARMUPS = 10;
const BENCHMARK_RUNS = 100;
const BENCHMARK_TOTAL = BENCHMARK_WARMUPS + BENCHMARK_RUNS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resultLocus(
  anchor: CanonicalInkLocus,
  currentSurface: InkSurfaceSize | null,
) {
  const surface = currentSurface ?? anchor.coordinateSpace;
  const mapped = transformCoordinatePoint(
    anchor.center,
    fitCoordinateSpace(anchor.coordinateSpace, surface),
  );
  const horizontalMargin = Math.min(72, surface.width * 0.2);
  const topMargin = Math.min(210, surface.height * 0.34);
  const bottomMargin = Math.min(150, surface.height * 0.25);
  return {
    inkX: mapped.x,
    inkY: mapped.y,
    resultX: clamp(
      mapped.x,
      horizontalMargin,
      surface.width - horizontalMargin,
    ),
    resultY: clamp(
      mapped.y,
      topMargin,
      Math.max(topMargin, surface.height - bottomMargin),
    ),
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const initialBenchmarkState: BenchmarkViewState = {
  status: "idle",
  completed: 0,
  total: BENCHMARK_TOTAL,
  summary: null,
  error: null,
};

class RecognitionPadStore {
  input: VoteInputState = initialVoteInputState;
  recognizer: RecognizerStatus = initialRecognizerStatus;
  threshold = POC_BROWSER_DEFAULT_CONFIDENCE_THRESHOLD;
  numericDeck: readonly number[] = DEFAULT_NUMERIC_DECK;
  ink: InkPadHandle | null = null;
  flowDiagnostics: FlowDiagnostics = initialFlowDiagnostics;
  resultLocus: CanonicalInkLocus | null = null;
  reducedMotion = false;

  reduceInput(event: VoteInputEvent): VoteInputState {
    const previous = this.input;
    if (event.type === "BEGIN_COMMIT") {
      this.resultLocus = this.ink?.getCanonicalInkLocus() ?? null;
    }
    this.input = voteInputReducer(this.input, event);
    if (
      event.type === "POINTER_ACCEPTED" ||
      (event.type === "CLEAR" && previous.status !== "committed") ||
      (event.type === "EFFECT_COMPLETED" && this.input.status === "empty")
    ) {
      this.resultLocus = null;
    }
    return this.input;
  }

  updateRecognizer(status: RecognizerStatus): RecognizerStatus {
    this.recognizer = recognizerReducer(this.recognizer, {
      type: "STATUS_CHANGED",
      status,
    });
    return this.recognizer;
  }

  updateFlowDiagnostics(patch: Partial<FlowDiagnostics>): FlowDiagnostics {
    this.flowDiagnostics = { ...this.flowDiagnostics, ...patch };
    return this.flowDiagnostics;
  }

  setInk(handle: InkPadHandle | null): void {
    this.ink = handle;
  }

  setThreshold(value: number): void {
    this.threshold = value;
  }

  setNumericDeck(values: readonly number[]): void {
    this.numericDeck = values;
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }
}

function createDefaultRuntime(): RecognitionRuntime {
  return new RecognitionClient({
    preprocessingVersion: PREPROCESSING_CONFIG.version,
  });
}

function diagnosticsFromLocation(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("diagnostics") === "1"
  );
}

function interactionStatusText(
  recognizer: RecognizerStatus,
  input: VoteInputState,
  inkStats: InkStats,
): string {
  if (input.status === "committed") {
    return `Vote ${input.value} committed. Drawing locked.`;
  }
  if (input.status === "committing") {
    return `Committing vote ${input.value}.`;
  }
  if (input.status === "clearing") {
    return "Clearing vote.";
  }
  if (recognizer.readiness !== "ready") {
    return recognizer.readiness;
  }
  if (input.status === "settling") {
    return "Reading ink";
  }
  if (input.status === "rejecting") {
    if (input.rejection === "invalid") {
      return "Not in this deck";
    }
    return input.rejection === "incomplete"
      ? "Input incomplete"
      : "Input dismissed";
  }
  if (inkStats.strokeCount === 0) {
    return "Surface ready";
  }
  return `${inkStats.strokeCount} ${inkStats.strokeCount === 1 ? "stroke" : "strokes"}`;
}

export interface RecognitionPadProps {
  createRuntime?: () => RecognitionRuntime;
  diagnosticsEnabled?: boolean;
}

export function RecognitionPad({
  createRuntime = createDefaultRuntime,
  diagnosticsEnabled,
}: RecognitionPadProps) {
  const [store] = useState(() => new RecognitionPadStore());
  const [reducedMotion, setReducedMotion] = useState(() => {
    const value = prefersReducedMotion();
    store.setReducedMotion(value);
    return value;
  });
  const runtimeRef = useRef<RecognitionRuntime | null>(null);
  const [input, setInput] = useState(store.input);
  const [recognizer, setRecognizer] = useState(store.recognizer);
  const [inkStats, setInkStats] = useState<InkStats>(EMPTY_INK_STATS);
  const [activePointer, setActivePointer] = useState(false);
  const [surfaceSize, setSurfaceSize] = useState<InkSurfaceSize | null>(null);
  const [threshold, setThresholdState] = useState(store.threshold);
  const [deckInput, setDeckInput] = useState(DEFAULT_NUMERIC_DECK.join(", "));
  const parsedDeck = useMemo(() => parseNumericDeck(deckInput), [deckInput]);
  const [flowDiagnostics, setFlowDiagnostics] = useState(store.flowDiagnostics);
  const [benchmark, setBenchmark] = useState(initialBenchmarkState);
  const benchmarkAbortRef = useRef<AbortController | null>(null);
  const focusAfterClearRef = useRef(false);

  const dispatchInput = (event: VoteInputEvent) => {
    setInput(store.reduceInput(event));
  };

  const updateFlowDiagnostics = (patch: Partial<FlowDiagnostics>) => {
    setFlowDiagnostics(store.updateFlowDiagnostics(patch));
  };

  const [flow] = useState(
    () =>
      new RecognitionFlow({
        getState: () => store.input,
        dispatch: dispatchInput,
        getRecognizerStatus: () => store.recognizer,
        getConfidenceThreshold: () => store.threshold,
        getNumericDeck: () => store.numericDeck,
        getInk: () => store.ink,
        getReducedMotion: () => store.reducedMotion,
        onDiagnostics: updateFlowDiagnostics,
      }),
  );
  const [setInkHandle] = useState(() => (handle: InkPadHandle | null) => {
    store.setInk(handle);
  });
  const [surfaceChanged] = useState(() => (next: InkSurfaceSize) => {
    setSurfaceSize((current) =>
      current?.width === next.width && current.height === next.height
        ? current
        : next,
    );
  });

  useEffect(() => {
    const runtime = createRuntime();
    runtimeRef.current = runtime;
    flow.setRuntime(runtime);
    const applyStatus = (status: RecognizerStatus) => {
      const next = store.updateRecognizer(status);
      setRecognizer(next);
      flow.recognizerStatusChanged(next);
    };
    const unsubscribe = runtime.subscribe(applyStatus);

    return () => {
      benchmarkAbortRef.current?.abort();
      unsubscribe();
      flow.setRuntime(null);
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
      runtime.dispose();
    };
  }, [createRuntime, flow, store]);

  useEffect(() => () => flow.dispose(), [flow]);

  useEffect(() => {
    if (input.status === "empty" && focusAfterClearRef.current) {
      focusAfterClearRef.current = false;
      store.ink?.focus();
    }
  }, [input.status, store]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      store.setReducedMotion(query.matches);
      setReducedMotion(query.matches);
    };
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [store]);

  const setThreshold = (value: number) => {
    store.setThreshold(value);
    setThresholdState(value);
    flow.recognitionConfigurationChanged();
  };

  const changeDeckInput = (value: string) => {
    store.setNumericDeck(parseNumericDeck(value).values);
    setDeckInput(value);
    flow.recognitionConfigurationChanged();
  };

  const clear = (restoreKeyboardFocus = false) => {
    benchmarkAbortRef.current?.abort();
    focusAfterClearRef.current = restoreKeyboardFocus;
    flow.clear();
  };

  const benchmarkAvailable =
    recognizer.readiness === "ready" &&
    flowDiagnostics.raster !== null &&
    !flowDiagnostics.inferencePending &&
    flowDiagnostics.timerReason === null &&
    !activePointer &&
    benchmark.status !== "running" &&
    ["empty", "drawing", "committed"].includes(input.status);

  const startBenchmark = () => {
    const runtime = runtimeRef.current;
    const raster = store.flowDiagnostics.raster;
    if (!runtime || !raster || !benchmarkAvailable) {
      return;
    }
    const controller = new AbortController();
    benchmarkAbortRef.current?.abort();
    benchmarkAbortRef.current = controller;
    const revision = store.input.revision;
    const modelTimings: number[] = [];
    const roundTripTimings: number[] = [];
    setBenchmark({
      status: "running",
      completed: 0,
      total: BENCHMARK_TOTAL,
      summary: null,
      error: null,
    });

    void (async () => {
      try {
        for (let index = 0; index < BENCHMARK_TOTAL; index += 1) {
          if (controller.signal.aborted) {
            throw new DOMException("Benchmark cancelled", "AbortError");
          }
          const startedAt = performance.now();
          const result = await runtime.recognize(
            {
              data: new Float32Array(raster),
              shape: MODEL_INPUT_SHAPE,
              preprocessingVersion: PREPROCESSING_CONFIG.version,
              rasterizationMs: 0,
            },
            revision,
          );
          if (controller.signal.aborted) {
            throw new DOMException("Benchmark cancelled", "AbortError");
          }
          if (index >= BENCHMARK_WARMUPS) {
            modelTimings.push(result.inferenceMs);
            roundTripTimings.push(
              result.diagnostics.timing.workerRoundTripMs ??
                performance.now() - startedAt,
            );
          }
          startTransition(() => {
            setBenchmark((current) => ({
              ...current,
              completed: index + 1,
            }));
          });
        }
        setBenchmark({
          status: "complete",
          completed: BENCHMARK_TOTAL,
          total: BENCHMARK_TOTAL,
          summary: benchmarkStats(modelTimings, roundTripTimings),
          error: null,
        });
      } catch (error) {
        const cancelled =
          controller.signal.aborted || store.input.revision !== revision;
        setBenchmark({
          status: cancelled ? "cancelled" : "failed",
          completed: 0,
          total: BENCHMARK_TOTAL,
          summary: null,
          error: cancelled
            ? null
            : error instanceof Error
              ? error.message
              : String(error),
        });
      } finally {
        if (benchmarkAbortRef.current === controller) {
          benchmarkAbortRef.current = null;
        }
      }
    })();
  };

  const cancelBenchmark = () => {
    benchmarkAbortRef.current?.abort();
    setBenchmark((current) => ({
      ...current,
      status: "cancelled",
      error: null,
    }));
  };

  const showDiagnostics = diagnosticsEnabled ?? diagnosticsFromLocation();
  const drawingEnabled =
    recognizer.readiness === "ready" && input.status !== "committed";
  const resultVisible =
    input.value !== null &&
    ["committing", "committed", "clearing"].includes(input.status);
  const statusText = interactionStatusText(recognizer, input, inkStats);
  const effectReducedMotion = input.effectMotion
    ? input.effectMotion === "reduced"
    : reducedMotion;
  const durations = effectDurations(effectReducedMotion);
  const rejectionEffect = input.rejection
    ? rejectionAnimation(input.rejection)
    : null;
  const inkEffect =
    input.status === "committing"
      ? "resolve"
      : input.status === "rejecting"
        ? rejectionEffect
        : input.status === "clearing"
          ? "clear"
          : "none";
  const locus = store.resultLocus
    ? resultLocus(store.resultLocus, surfaceSize)
    : null;
  const shellStyle = {
    "--commit-effect-ms": `${durations.commit}ms`,
    "--invalid-effect-ms": `${durations.invalid}ms`,
    "--dissipate-effect-ms": `${durations.dissipate}ms`,
    "--clear-effect-ms": `${durations.clear}ms`,
    "--ink-center-x": locus ? `${locus.inkX}px` : "50%",
    "--ink-center-y": locus ? `${locus.inkY}px` : "56%",
    "--result-center-x": locus ? `${locus.resultX}px` : "50%",
    "--result-center-y": locus ? `${locus.resultY}px` : "56%",
    "--ink-settle-x": locus ? `${locus.resultX - locus.inkX}px` : "0px",
    "--ink-settle-y": locus ? `${locus.resultY - locus.inkY}px` : "0px",
    "--result-enter-x": locus ? `${locus.inkX - locus.resultX}px` : "0px",
    "--result-enter-y": locus ? `${locus.inkY - locus.resultY}px` : "0px",
  } as CSSProperties;

  return (
    <main
      className={`ink-shell input-${input.status}`}
      data-input-state={input.status}
      data-recognizer-state={recognizer.readiness}
      data-rejection={input.rejection ?? "none"}
      data-ink-effect={inkEffect}
      data-motion={effectReducedMotion ? "reduced" : "full"}
      style={shellStyle}
    >
      <div className="atmosphere" aria-hidden="true" />
      <div className="writing-guide" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <InkPad
        ref={setInkHandle}
        enabled={drawingEnabled}
        className={`ink-canvas-${input.status}`}
        onPointerAccepted={() => {
          benchmarkAbortRef.current?.abort();
          focusAfterClearRef.current = false;
          flow.pointerAccepted();
        }}
        onActivePointerChange={setActivePointer}
        onStrokeComplete={(stats) => {
          setInkStats(stats);
          flow.strokeCompleted();
        }}
        onStrokeCancel={(_reason, stats) => {
          setInkStats(stats);
          flow.strokeCancelled();
        }}
        onSurfaceChange={surfaceChanged}
        onClear={() => {
          setInkStats(EMPTY_INK_STATS);
          setActivePointer(false);
        }}
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

      {recognizer.readiness !== "ready" && (
        <section className="recognizer-gate" aria-live="polite">
          {recognizer.readiness === "loading" ? (
            <>
              <span>Preparing local recognition</span>
              <strong>{recognizer.status}</strong>
              <progress max="1" value={recognizer.progress} />
            </>
          ) : (
            <>
              <span>Recognition unavailable</span>
              <strong>{recognizer.error?.message ?? recognizer.status}</strong>
              {recognizer.error?.recoverable !== false && (
                <button type="button" onClick={() => flow.retry()}>
                  Retry recognizer
                </button>
              )}
            </>
          )}
        </section>
      )}

      {input.inferenceError && recognizer.readiness === "ready" && (
        <section className="inference-notice" aria-live="polite">
          <span>Ink preserved. Recognition did not finish.</span>
          <button type="button" onClick={() => flow.retry()}>
            Try recognition again
          </button>
        </section>
      )}

      {resultVisible && (
        <section
          className="committed-result"
          data-result-phase={input.status}
          aria-live="polite"
        >
          <output
            aria-label={
              input.status === "clearing"
                ? `Clearing vote ${input.value}`
                : `Committed vote ${input.value}`
            }
          >
            {input.value}
          </output>
          {(input.status === "committed" || input.status === "clearing") && (
            <button
              className="result-clear"
              type="button"
              disabled={input.status === "clearing"}
              onClick={(event) => clear(event.detail === 0)}
            >
              Clear and try again
            </button>
          )}
        </section>
      )}

      <div className="mock-deck" aria-label="Current mock deck">
        {parsedDeck.values.map((value) => (
          <span key={value}>{value}</span>
        ))}
        <span title="Coffee is deck context, not handwriting input">
          coffee
        </span>
      </div>

      <footer className="ink-toolbar">
        <p className="stroke-status" aria-live="polite" aria-atomic="true">
          <span className="status-indicator" aria-hidden="true" />
          <span className="status-copy" key={statusText}>
            {statusText}
          </span>
        </p>
        {(input.status === "drawing" || input.status === "settling") &&
          inkStats.strokeCount > 0 && (
            <button
              type="button"
              onClick={(event) => clear(event.detail === 0)}
            >
              <span>Clear surface</span>
            </button>
          )}
      </footer>

      {showDiagnostics && (
        <Diagnostics
          recognizer={recognizer}
          input={input}
          inkStats={inkStats}
          activePointer={activePointer}
          flow={flowDiagnostics}
          threshold={threshold}
          onThresholdChange={setThreshold}
          deckInput={deckInput}
          parsedDeck={parsedDeck}
          onDeckInputChange={changeDeckInput}
          benchmark={benchmark}
          benchmarkAvailable={benchmarkAvailable}
          onStartBenchmark={startBenchmark}
          onCancelBenchmark={cancelBenchmark}
        />
      )}
    </main>
  );
}
