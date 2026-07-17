import { CARD_STROKES } from "./strokes";
import type { StrokeTemplate } from "./strokes";
import { VALID_STROKE_VARIANTS } from "./valid-strokes";

export type ConfidenceCorpusCategory =
  "default-card" | "valid-variant" | "invalid-mark" | "edge-case";

export interface ConfidenceCorpusCase {
  readonly name: string;
  readonly category: ConfidenceCorpusCategory;
  readonly strokes: StrokeTemplate;
  readonly viewport?: { readonly width: number; readonly height: number };
  readonly expected: {
    readonly raw: string;
    readonly greedy: string;
    readonly confidence: number | null;
    readonly thresholdPass: "yes" | "no" | "-";
    /** Undefined records inference evidence without pinning the UI disposition. */
    readonly commit?: string | null;
  };
}

const DEFAULT_OUTCOMES = {
  "1": 0.999768,
  "2": 0.992332,
  "3": 0.99987,
  "5": 0.999974,
  "8": 0.997662,
  "13": 0.99976,
} as const;

const VALID_VARIANT_OUTCOMES: Readonly<Record<string, number>> = {
  "unscaled-landscape-2": 0.999531,
  "unscaled-landscape-3": 0.999552,
  "unscaled-landscape-5": 0.999601,
  "unscaled-landscape-8": 0.974351,
  "joined-two-stroke-5": 0.999929,
  "based-1": 0.999639,
  "two-loop-8": 0.992308,
  "non-aliased-13": 0.999619,
};

export const CONFIDENCE_CORPUS: readonly ConfidenceCorpusCase[] = [
  ...(["1", "2", "3", "5", "8", "13"] as const).map((value) => ({
    name: `default-${value}`,
    category: "default-card" as const,
    strokes: CARD_STROKES[value],
    expected: {
      raw: value,
      greedy: value,
      confidence: DEFAULT_OUTCOMES[value],
      thresholdPass: "yes" as const,
      commit: value,
    },
  })),
  ...VALID_STROKE_VARIANTS.map((variant) => ({
    name: variant.name,
    category: "valid-variant" as const,
    strokes: variant.strokes,
    viewport: variant.viewport,
    expected: {
      raw: variant.expectedText,
      greedy: variant.expectedText,
      confidence: VALID_VARIANT_OUTCOMES[variant.name],
      thresholdPass: "yes" as const,
      commit: variant.expectedText,
    },
  })),
  {
    name: "tiny-diagonal",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.5, y: 0.5 },
        { x: 0.505, y: 0.505 },
      ],
    ],
    expected: {
      raw: "-",
      greedy: "-",
      confidence: null,
      thresholdPass: "-",
      commit: null,
    },
  },
  {
    name: "horizontal-dash",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.34, y: 0.52 },
        { x: 0.66, y: 0.52 },
      ],
    ],
    expected: {
      raw: "-",
      greedy: "-",
      confidence: 0.870621,
      thresholdPass: "no",
      commit: null,
    },
  },
  {
    name: "cross",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.38, y: 0.38 },
        { x: 0.62, y: 0.68 },
      ],
      [
        { x: 0.62, y: 0.38 },
        { x: 0.38, y: 0.68 },
      ],
    ],
    expected: {
      raw: "-",
      greedy: "-",
      confidence: 0.739076,
      thresholdPass: "no",
      commit: null,
    },
  },
  {
    name: "circle",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.5, y: 0.35 },
        { x: 0.6, y: 0.39 },
        { x: 0.64, y: 0.52 },
        { x: 0.6, y: 0.66 },
        { x: 0.5, y: 0.7 },
        { x: 0.4, y: 0.66 },
        { x: 0.36, y: 0.52 },
        { x: 0.4, y: 0.39 },
        { x: 0.5, y: 0.35 },
      ],
    ],
    expected: {
      raw: "0",
      greedy: "0",
      confidence: 0.819466,
      thresholdPass: "no",
      commit: null,
    },
  },
  {
    name: "letter-m",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.32, y: 0.68 },
        { x: 0.32, y: 0.36 },
        { x: 0.46, y: 0.56 },
        { x: 0.58, y: 0.36 },
        { x: 0.7, y: 0.56 },
        { x: 0.7, y: 0.68 },
      ],
    ],
    expected: {
      raw: "11",
      greedy: "11",
      confidence: 0.995869,
      thresholdPass: "yes",
      commit: null,
    },
  },
  {
    name: "zigzag",
    category: "invalid-mark",
    strokes: [
      [
        { x: 0.32, y: 0.38 },
        { x: 0.68, y: 0.38 },
        { x: 0.35, y: 0.52 },
        { x: 0.68, y: 0.68 },
        { x: 0.32, y: 0.68 },
      ],
    ],
    expected: {
      raw: "3",
      greedy: "3",
      confidence: 0.998133,
      thresholdPass: "yes",
    },
  },
  {
    name: "tight-13",
    category: "edge-case",
    strokes: [
      [
        { x: 0.37, y: 0.44 },
        { x: 0.42, y: 0.35 },
        { x: 0.42, y: 0.68 },
      ],
      [
        { x: 0.48, y: 0.38 },
        { x: 0.55, y: 0.35 },
        { x: 0.62, y: 0.39 },
        { x: 0.59, y: 0.51 },
        { x: 0.52, y: 0.52 },
        { x: 0.6, y: 0.55 },
        { x: 0.63, y: 0.65 },
        { x: 0.56, y: 0.69 },
        { x: 0.48, y: 0.66 },
      ],
    ],
    expected: {
      raw: "18",
      greedy: "18",
      confidence: 0.714999,
      thresholdPass: "no",
      commit: null,
    },
  },
  {
    name: "repeated-11",
    category: "edge-case",
    strokes: [
      [
        { x: 0.27, y: 0.44 },
        { x: 0.34, y: 0.35 },
        { x: 0.34, y: 0.68 },
      ],
      [
        { x: 0.54, y: 0.44 },
        { x: 0.61, y: 0.35 },
        { x: 0.61, y: 0.68 },
      ],
    ],
    expected: {
      raw: "11",
      greedy: "11",
      confidence: 0.999948,
      thresholdPass: "yes",
      commit: null,
    },
  },
  {
    name: "overlap-13",
    category: "edge-case",
    strokes: [
      [
        { x: 0.34, y: 0.44 },
        { x: 0.42, y: 0.35 },
        { x: 0.42, y: 0.68 },
      ],
      [
        { x: 0.38, y: 0.38 },
        { x: 0.48, y: 0.35 },
        { x: 0.58, y: 0.39 },
        { x: 0.54, y: 0.5 },
        { x: 0.45, y: 0.52 },
        { x: 0.54, y: 0.54 },
        { x: 0.59, y: 0.64 },
        { x: 0.49, y: 0.69 },
        { x: 0.38, y: 0.66 },
      ],
    ],
    expected: {
      raw: "8",
      greedy: "8",
      confidence: 0.99054,
      thresholdPass: "yes",
    },
  },
];
