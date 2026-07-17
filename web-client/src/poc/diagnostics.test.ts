import { describe, expect, it } from "vitest";

import { benchmarkStats, parseNumericDeck } from "./diagnostics";

describe("diagnostic deck parsing", () => {
  it("accepts canonical 0..255 values, preserves order, and deduplicates", () => {
    expect(parseNumericDeck("1, 2 13,2,0,255")).toEqual({
      values: [1, 2, 13, 0, 255],
      rejected: [],
    });
  });

  it("rejects noncanonical and out-of-range entries without accepting coffee", () => {
    expect(parseNumericDeck("01,-1,256,coffee, 5")).toEqual({
      values: [5],
      rejected: ["01", "-1", "256", "coffee"],
    });
  });
});

describe("benchmark statistics", () => {
  it("reports exact median and nearest-rank p95 for aligned runs", () => {
    const model = Array.from({ length: 100 }, (_, index) => index + 1);
    const roundTrip = model.map((value) => value * 2);
    expect(benchmarkStats(model, roundTrip)).toEqual({
      runs: 100,
      model: { median: 50.5, p95: 95 },
      roundTrip: { median: 101, p95: 190 },
    });
  });

  it("rejects empty, misaligned, and non-finite timing series", () => {
    expect(() => benchmarkStats([], [])).toThrow(RangeError);
    expect(() => benchmarkStats([1], [1, 2])).toThrow(RangeError);
    expect(() => benchmarkStats([Number.NaN], [1])).toThrow(RangeError);
  });
});
