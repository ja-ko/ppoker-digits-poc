import { CARD_STROKES } from "./strokes";
import type { StrokeTemplate } from "./strokes";

export interface ValidStrokeVariant {
  readonly name: string;
  readonly expectedText: string;
  readonly strokes: StrokeTemplate;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export const VALID_STROKE_VARIANTS: readonly ValidStrokeVariant[] = [
  ...(["2", "3", "5", "8"] as const).map((value) => ({
    name: `unscaled-landscape-${value}`,
    expectedText: value,
    strokes: CARD_STROKES[value],
    viewport: { width: 844, height: 390 },
  })),
  {
    name: "joined-two-stroke-5",
    expectedText: "5",
    strokes: [
      [
        { x: 0.62, y: 0.35 },
        { x: 0.43, y: 0.35 },
      ],
      [
        { x: 0.43, y: 0.35 },
        { x: 0.4, y: 0.49 },
        { x: 0.48, y: 0.48 },
        { x: 0.58, y: 0.5 },
        { x: 0.63, y: 0.57 },
        { x: 0.6, y: 0.66 },
        { x: 0.51, y: 0.71 },
        { x: 0.42, y: 0.68 },
        { x: 0.37, y: 0.63 },
      ],
    ],
  },
  {
    name: "based-1",
    expectedText: "1",
    strokes: [
      [
        { x: 0.4, y: 0.45 },
        { x: 0.48, y: 0.38 },
        { x: 0.53, y: 0.34 },
        { x: 0.53, y: 0.68 },
        { x: 0.65, y: 0.68 },
      ],
    ],
  },
  {
    name: "two-loop-8",
    expectedText: "8",
    strokes: [
      [
        { x: 0.5, y: 0.51 },
        { x: 0.42, y: 0.47 },
        { x: 0.4, y: 0.39 },
        { x: 0.45, y: 0.34 },
        { x: 0.53, y: 0.33 },
        { x: 0.6, y: 0.38 },
        { x: 0.58, y: 0.46 },
        { x: 0.5, y: 0.51 },
      ],
      [
        { x: 0.5, y: 0.51 },
        { x: 0.41, y: 0.57 },
        { x: 0.39, y: 0.64 },
        { x: 0.44, y: 0.72 },
        { x: 0.53, y: 0.74 },
        { x: 0.61, y: 0.68 },
        { x: 0.6, y: 0.59 },
        { x: 0.5, y: 0.51 },
      ],
    ],
  },
  {
    name: "non-aliased-13",
    expectedText: "13",
    strokes: [
      [
        { x: 0.2, y: 0.43 },
        { x: 0.27, y: 0.36 },
        { x: 0.29, y: 0.7 },
      ],
      [
        { x: 0.49, y: 0.39 },
        { x: 0.58, y: 0.34 },
        { x: 0.69, y: 0.38 },
        { x: 0.67, y: 0.47 },
        { x: 0.59, y: 0.51 },
        { x: 0.68, y: 0.55 },
        { x: 0.72, y: 0.64 },
        { x: 0.66, y: 0.7 },
        { x: 0.55, y: 0.69 },
        { x: 0.49, y: 0.64 },
      ],
    ],
  },
];
