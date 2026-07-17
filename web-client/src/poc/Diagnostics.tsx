import { useEffect, useRef } from "react";

import { PREPROCESSING_CONFIG } from "../ink/rasterize";
import type { Recognition, RecognizerStatus } from "../recognition/types";
import type { InkStats } from "../InkPad";
import type { BenchmarkSummary, ParsedNumericDeck } from "./diagnostics";
import type { FlowDiagnostics } from "./recognition-flow";
import type { VoteInputState } from "./recognition-state";

export interface BenchmarkViewState {
  status: "idle" | "running" | "complete" | "cancelled" | "failed";
  completed: number;
  total: number;
  summary: BenchmarkSummary | null;
  error: string | null;
}

interface DiagnosticsProps {
  recognizer: RecognizerStatus;
  input: VoteInputState;
  inkStats: InkStats;
  activePointer: boolean;
  flow: FlowDiagnostics;
  threshold: number;
  onThresholdChange: (value: number) => void;
  deckInput: string;
  parsedDeck: ParsedNumericDeck;
  onDeckInputChange: (value: string) => void;
  benchmark: BenchmarkViewState;
  benchmarkAvailable: boolean;
  onStartBenchmark: () => void;
  onCancelBenchmark: () => void;
}

function formatMetric(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined
    ? "-"
    : Number.isFinite(value)
      ? value.toFixed(digits)
      : String(value);
}

function paintRaster(
  canvas: HTMLCanvasElement,
  data: Float32Array | null,
): void {
  const { width, height } = PREPROCESSING_CONFIG;
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const image = context.createImageData(width, height);
  for (let index = 0; index < width * height; index += 1) {
    const value = Math.round((data?.[index] ?? 0) * 255);
    const offset = index * 4;
    image.data[offset] = value;
    image.data[offset + 1] = value;
    image.data[offset + 2] = value;
    image.data[offset + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

export function Diagnostics({
  recognizer,
  input,
  inkStats,
  activePointer,
  flow,
  threshold,
  onThresholdChange,
  deckInput,
  parsedDeck,
  onDeckInputChange,
  benchmark,
  benchmarkAvailable,
  onStartBenchmark,
  onCancelBenchmark,
}: DiagnosticsProps) {
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const recognition: Recognition | null = flow.recognition;

  useEffect(() => {
    if (rasterRef.current) {
      paintRaster(rasterRef.current, flow.raster);
    }
  }, [flow.raster]);

  return (
    <aside className="diagnostics" aria-label="Recognition diagnostics">
      <div className="diagnostics-heading">
        <strong>Diagnostics</strong>
        <span>{PREPROCESSING_CONFIG.version}</span>
      </div>

      <canvas
        ref={rasterRef}
        className="diagnostics-raster"
        width={PREPROCESSING_CONFIG.width}
        height={PREPROCESSING_CONFIG.height}
        role="img"
        aria-label="Exact 128 by 32 nearest-neighbor recognition raster"
      />

      <dl className="diagnostics-grid">
        <div>
          <dt>runtime</dt>
          <dd>{recognizer.readiness}</dd>
        </div>
        <div>
          <dt>runtime detail</dt>
          <dd>{recognizer.error?.message ?? recognizer.status}</dd>
        </div>
        <div>
          <dt>input</dt>
          <dd>{input.status}</dd>
        </div>
        <div>
          <dt>revision</dt>
          <dd>{input.revision}</dd>
        </div>
        <div>
          <dt>pointer</dt>
          <dd>{activePointer ? "active" : "idle"}</dd>
        </div>
        <div>
          <dt>timer</dt>
          <dd>
            {flow.timerReason ?? "none"}
            {flow.timerDeadline !== null &&
              ` @ ${flow.timerDeadline.toFixed(1)}`}
          </dd>
        </div>
        <div>
          <dt>strokes / points</dt>
          <dd>
            {inkStats.strokeCount} / {inkStats.pointCount}
          </dd>
        </div>
        <div>
          <dt>raw text</dt>
          <dd>{recognition?.text || "-"}</dd>
        </div>
        <div>
          <dt>greedy text</dt>
          <dd>{recognition?.diagnostics.greedyText || "-"}</dd>
        </div>
        <div>
          <dt>confidence</dt>
          <dd>{formatMetric(recognition?.confidence, 6)}</dd>
        </div>
        <div>
          <dt>threshold pass</dt>
          <dd>
            {recognition
              ? recognition.confidence >= threshold
                ? "yes"
                : "no"
              : "-"}
          </dd>
        </div>
        <div>
          <dt>top / second</dt>
          <dd>
            {formatMetric(recognition?.diagnostics.topScore, 3)} /{" "}
            {formatMetric(recognition?.diagnostics.secondScore, 3)}
          </dd>
        </div>
        <div>
          <dt>margin</dt>
          <dd>{formatMetric(recognition?.diagnostics.margin, 3)}</dd>
        </div>
        <div>
          <dt>raw margin threshold</dt>
          <dd>{formatMetric(recognition?.diagnostics.rawThreshold, 3)}</dd>
        </div>
        <div>
          <dt>raster ms</dt>
          <dd>{formatMetric(flow.rasterizationMs)}</dd>
        </div>
        <div>
          <dt>model ms</dt>
          <dd>{formatMetric(recognition?.diagnostics.timing.inferenceMs)}</dd>
        </div>
        <div>
          <dt>worker ms</dt>
          <dd>{formatMetric(recognition?.diagnostics.timing.workerMs)}</dd>
        </div>
        <div>
          <dt>roundtrip ms</dt>
          <dd>
            {formatMetric(recognition?.diagnostics.timing.workerRoundTripMs)}
          </dd>
        </div>
      </dl>

      <div className="diagnostics-alternatives">
        <span>alternatives / CTC log score</span>
        <ol>
          {recognition?.alternatives.map((alternative) => (
            <li key={`${alternative.text}:${alternative.score}`}>
              <code>{alternative.text || "<empty>"}</code>
              <span>{formatMetric(alternative.score, 4)}</span>
            </li>
          )) ?? <li>none</li>}
        </ol>
      </div>

      <label className="diagnostics-control">
        <span>Confidence threshold</span>
        <input
          type="number"
          min="0"
          max="1"
          step="0.001"
          value={threshold}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) {
              onThresholdChange(Math.min(1, Math.max(0, value)));
            }
          }}
        />
      </label>

      <label className="diagnostics-control">
        <span>Numeric mock deck</span>
        <input
          type="text"
          value={deckInput}
          onChange={(event) => onDeckInputChange(event.target.value)}
          spellCheck={false}
        />
      </label>
      <p className="diagnostics-deck-result">
        accepted: {parsedDeck.values.join(", ") || "none"}; context: coffee
        {parsedDeck.rejected.length > 0 && (
          <>; rejected: {parsedDeck.rejected.join(", ")}</>
        )}
      </p>

      <div className="diagnostics-benchmark">
        <div>
          <span>Warm benchmark</span>
          <small>10 warmups + 100 measured runs</small>
        </div>
        {benchmark.status === "running" ? (
          <button type="button" onClick={onCancelBenchmark}>
            Cancel {benchmark.completed}/{benchmark.total}
          </button>
        ) : (
          <button
            type="button"
            disabled={!benchmarkAvailable}
            onClick={onStartBenchmark}
          >
            Run benchmark
          </button>
        )}
        {benchmark.summary && (
          <p>
            Model median/p95 {formatMetric(benchmark.summary.model.median)}/
            {formatMetric(benchmark.summary.model.p95)} ms; roundtrip median/p95{" "}
            {formatMetric(benchmark.summary.roundTrip.median)}/
            {formatMetric(benchmark.summary.roundTrip.p95)} ms
          </p>
        )}
        {benchmark.error && <p>{benchmark.error}</p>}
      </div>
    </aside>
  );
}
