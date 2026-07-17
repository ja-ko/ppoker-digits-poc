import { canonicalValue } from "../recognition/types";

export interface ParsedNumericDeck {
  values: number[];
  rejected: string[];
}

export function parseNumericDeck(input: string): ParsedNumericDeck {
  const values: number[] = [];
  const rejected: string[] = [];
  const seen = new Set<number>();
  for (const token of input.split(/[\s,]+/).filter(Boolean)) {
    const value = canonicalValue(token);
    if (value === null) {
      rejected.push(token);
    } else if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return { values, rejected };
}

export interface TimingSummary {
  median: number;
  p95: number;
}

export interface BenchmarkSummary {
  runs: number;
  model: TimingSummary;
  roundTrip: TimingSummary;
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, index)];
}

function summarize(values: readonly number[]): TimingSummary {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("benchmark timings must contain finite values");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return { median, p95: percentile(sorted, 0.95) };
}

export function benchmarkStats(
  modelTimings: readonly number[],
  roundTripTimings: readonly number[],
): BenchmarkSummary {
  if (
    modelTimings.length === 0 ||
    modelTimings.length !== roundTripTimings.length
  ) {
    throw new RangeError(
      "benchmark timing series must be non-empty and aligned",
    );
  }
  return {
    runs: modelTimings.length,
    model: summarize(modelTimings),
    roundTrip: summarize(roundTripTimings),
  };
}
