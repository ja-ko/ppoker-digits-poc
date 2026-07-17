import type { Page } from "@playwright/test";

export interface CanvasInkSnapshot {
  readonly alphaPixels: number;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  } | null;
  readonly hash: string;
  readonly logicalCenter: { readonly x: number; readonly y: number } | null;
}

export async function settlePaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

export async function canvasInkSnapshot(
  page: Page,
): Promise<CanvasInkSnapshot> {
  return page
    .locator("canvas.ink-canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("ink canvas has no 2D context");
      }
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let alphaPixels = 0;
      let hash = 0x811c9dc5;
      let minX = canvas.width;
      let minY = canvas.height;
      let maxX = -1;
      let maxY = -1;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const alpha = pixels[offset + 3];
        if (alpha === 0) {
          continue;
        }
        const pixel = offset / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        alphaPixels += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        for (let channel = 0; channel < 4; channel += 1) {
          hash ^= pixels[offset + channel];
          hash = Math.imul(hash, 0x01000193);
        }
      }
      const bounds = alphaPixels > 0 ? { minX, minY, maxX, maxY } : null;
      return {
        alphaPixels,
        bounds,
        hash: (hash >>> 0).toString(16).padStart(8, "0"),
        logicalCenter: bounds
          ? {
              x:
                ((bounds.minX + bounds.maxX) / 2) *
                (canvas.clientWidth / canvas.width),
              y:
                ((bounds.minY + bounds.maxY) / 2) *
                (canvas.clientHeight / canvas.height),
            }
          : null,
      };
    });
}
