import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { InkPad } from "../InkPad";
import type { InkPadHandle, InkStats } from "../InkPad";
import { PREPROCESSING_CONFIG } from "../ink/rasterize";
import { RecognitionClient } from "../recognition/client";
import { MODEL_INPUT_SHAPE } from "../recognition/types";
import type { RecognizerStatus } from "../recognition/types";
import { Diagnostics } from "./Diagnostics";
import type { BenchmarkViewState } from "./Diagnostics";
import { benchmarkStats, parseNumericDeck } from "./diagnostics";
import {
  CLEAR_EFFECT_MS,
  COMMIT_EFFECT_MS,
  initialFlowDiagnostics,
  RecognitionFlow,
  REJECTION_EFFECT_MS,
} from "./recognition-flow";
import type { FlowDiagnostics, RecognitionRuntime } from "./recognition-flow";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_NUMERIC_DECK,
  initialRecognizerStatus,
  initialVoteInputState,
  recognizerReducer,
  voteInputReducer,
} from "./recognition-state";
import type { VoteInputEvent } from "./recognition-state";
import type { VoteInputState } from "./recognition-state";

const EMPTY_INK_STATS: InkStats = { strokeCount: 0, pointCount: 0 };
const BENCHMARK_WARMUPS = 10;
const BENCHMARK_RUNS = 100;
const BENCHMARK_TOTAL = BENCHMARK_WARMUPS + BENCHMARK_RUNS;

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
  threshold = DEFAULT_CONFIDENCE_THRESHOLD;
  numericDeck: readonly number[] = DEFAULT_NUMERIC_DECK;
  ink: InkPadHandle | null = null;
  flowDiagnostics: FlowDiagnostics = initialFlowDiagnostics;

  reduceInput(event: VoteInputEvent): VoteInputState {
    this.input = voteInputReducer(this.input, event);
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
  const runtimeRef = useRef<RecognitionRuntime | null>(null);
  const [input, setInput] = useState(store.input);
  const [recognizer, setRecognizer] = useState(store.recognizer);
  const [inkStats, setInkStats] = useState<InkStats>(EMPTY_INK_STATS);
  const [activePointer, setActivePointer] = useState(false);
  const [threshold, setThresholdState] = useState(store.threshold);
  const [deckInput, setDeckInput] = useState(DEFAULT_NUMERIC_DECK.join(", "));
  const parsedDeck = useMemo(() => parseNumericDeck(deckInput), [deckInput]);
  const [flowDiagnostics, setFlowDiagnostics] = useState(store.flowDiagnostics);
  const [benchmark, setBenchmark] = useState(initialBenchmarkState);
  const benchmarkAbortRef = useRef<AbortController | null>(null);

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
        onDiagnostics: updateFlowDiagnostics,
      }),
  );
  const [setInkHandle] = useState(() => (handle: InkPadHandle | null) => {
    store.setInk(handle);
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

  const clear = () => {
    benchmarkAbortRef.current?.abort();
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
    (input.status === "committing" || input.status === "committed");
  const statusText = interactionStatusText(recognizer, input, inkStats);
  const shellStyle = {
    "--commit-effect-ms": `${COMMIT_EFFECT_MS}ms`,
    "--reject-effect-ms": `${REJECTION_EFFECT_MS}ms`,
    "--clear-effect-ms": `${CLEAR_EFFECT_MS}ms`,
  } as CSSProperties;

  return (
    <main
      className={`ink-shell input-${input.status}`}
      data-input-state={input.status}
      data-recognizer-state={recognizer.readiness}
      data-rejection={input.rejection ?? "none"}
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
        <section className="committed-result" aria-live="polite">
          <output aria-label={`Committed vote ${input.value}`}>
            {input.value}
          </output>
          {input.status === "committed" && (
            <button type="button" onClick={clear}>
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
        <p className="stroke-status" aria-live="polite">
          <span aria-hidden="true" />
          {statusText}
        </p>
        {input.status !== "committed" && inkStats.strokeCount > 0 && (
          <button type="button" onClick={clear}>
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
