import type { Page } from "@playwright/test";

export interface RelativePoint {
  readonly x: number;
  readonly y: number;
}

export type StrokeTemplate = readonly (readonly RelativePoint[])[];

export const CARD_STROKES: Readonly<Record<string, StrokeTemplate>> = {
  "1": [
    [
      { x: 0.4, y: 0.44 },
      { x: 0.5, y: 0.35 },
      { x: 0.5, y: 0.68 },
    ],
  ],
  "2": [
    [
      { x: 0.38, y: 0.4 },
      { x: 0.46, y: 0.35 },
      { x: 0.57, y: 0.37 },
      { x: 0.6, y: 0.44 },
      { x: 0.55, y: 0.5 },
      { x: 0.38, y: 0.67 },
      { x: 0.61, y: 0.67 },
    ],
  ],
  "3": [
    [
      { x: 0.39, y: 0.38 },
      { x: 0.49, y: 0.35 },
      { x: 0.59, y: 0.39 },
      { x: 0.55, y: 0.5 },
      { x: 0.47, y: 0.52 },
      { x: 0.56, y: 0.54 },
      { x: 0.6, y: 0.64 },
      { x: 0.51, y: 0.69 },
      { x: 0.39, y: 0.66 },
    ],
  ],
  "5": [
    [
      { x: 0.6, y: 0.36 },
      { x: 0.4, y: 0.36 },
      { x: 0.39, y: 0.5 },
      { x: 0.51, y: 0.49 },
      { x: 0.6, y: 0.54 },
      { x: 0.59, y: 0.64 },
      { x: 0.5, y: 0.69 },
      { x: 0.39, y: 0.65 },
    ],
  ],
  "8": [
    [
      { x: 0.5, y: 0.52 },
      { x: 0.4, y: 0.45 },
      { x: 0.42, y: 0.36 },
      { x: 0.5, y: 0.33 },
      { x: 0.58, y: 0.37 },
      { x: 0.6, y: 0.45 },
      { x: 0.5, y: 0.52 },
      { x: 0.4, y: 0.59 },
      { x: 0.41, y: 0.68 },
      { x: 0.5, y: 0.72 },
      { x: 0.59, y: 0.67 },
      { x: 0.6, y: 0.59 },
      { x: 0.5, y: 0.52 },
    ],
  ],
  "13": [
    [
      { x: 0.22, y: 0.44 },
      { x: 0.3, y: 0.35 },
      { x: 0.3, y: 0.68 },
    ],
    [
      { x: 0.52, y: 0.38 },
      { x: 0.62, y: 0.35 },
      { x: 0.72, y: 0.39 },
      { x: 0.68, y: 0.5 },
      { x: 0.59, y: 0.52 },
      { x: 0.68, y: 0.54 },
      { x: 0.73, y: 0.64 },
      { x: 0.63, y: 0.69 },
      { x: 0.52, y: 0.66 },
    ],
  ],
};

async function viewportPoints(
  page: Page,
  points: readonly RelativePoint[],
): Promise<RelativePoint[]> {
  const surface = page.getByRole("region", { name: /Handwriting surface/ });
  const bounds = await surface.boundingBox();
  if (!bounds) {
    throw new Error("handwriting surface has no browser bounds");
  }
  return points.map((point) => ({
    x: bounds.x + point.x * bounds.width,
    y: bounds.y + point.y * bounds.height,
  }));
}

export async function drawMouseStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (!first) {
    throw new Error("a stroke needs at least one point");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of absolute.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
  await page.mouse.up();
}

export async function startMouseStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (!first) {
    throw new Error("a stroke needs at least one point");
  }
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const point of absolute.slice(1)) {
    await page.mouse.move(point.x, point.y, { steps: 2 });
  }
}

export async function cancelActiveMousePointer(page: Page): Promise<void> {
  await page
    .getByRole("region", { name: /Handwriting surface/ })
    .dispatchEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    });
  await page.mouse.up();
}

export async function drawTouchStroke(
  page: Page,
  points: readonly RelativePoint[],
): Promise<void> {
  const absolute = await viewportPoints(page, points);
  const first = absolute[0];
  if (!first) {
    throw new Error("a stroke needs at least one point");
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...first, id: 1, force: 0.5 }],
    });
    for (const point of absolute.slice(1)) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...point, id: 1, force: 0.5 }],
      });
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  } finally {
    await session.detach();
  }
}

export async function drawTemplate(
  page: Page,
  template: StrokeTemplate,
  firstStrokeAsTouch = false,
): Promise<void> {
  for (const [index, stroke] of template.entries()) {
    if (index === 0 && firstStrokeAsTouch) {
      await drawTouchStroke(page, stroke);
    } else {
      await drawMouseStroke(page, stroke);
    }
  }
}

export async function drawCard(
  page: Page,
  value: keyof typeof CARD_STROKES,
  firstStrokeAsTouch = false,
): Promise<void> {
  await drawTemplate(page, CARD_STROKES[value], firstStrokeAsTouch);
}

export async function pointerDownAtSurfaceEdge(page: Page): Promise<void> {
  const bounds = await page
    .getByRole("region", { name: /Handwriting surface/ })
    .boundingBox();
  if (!bounds) {
    throw new Error("handwriting surface has no browser bounds");
  }
  await page.mouse.move(bounds.x + 1, bounds.y + bounds.height * 0.58);
  await page.mouse.down();
}
