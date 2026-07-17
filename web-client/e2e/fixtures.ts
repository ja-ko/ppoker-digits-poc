import { expect, test as base } from "@playwright/test";
import type { Page } from "@playwright/test";

export const MODEL_READY_TIMEOUT_MS = 15_000;

async function waitForRecognizerState(
  page: Page,
  state: "ready",
): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLElement>("main.ink-shell")?.dataset
        .recognizerState === expected,
    state,
    { polling: 50, timeout: MODEL_READY_TIMEOUT_MS },
  );
}

interface E2EOptions {
  modelResponseDelayMs: number;
  readyPath: string;
}

interface E2EFixtures {
  readinessSetupMs: number;
  readyPage: Page;
}

const readinessSetupDurations = new WeakMap<Page, number>();

export async function resetSurface(page: Page): Promise<void> {
  const committedClear = page.getByRole("button", {
    name: "Clear and try again",
  });
  const drawingClear = page.getByRole("button", { name: "Clear surface" });
  if (await committedClear.isVisible()) {
    await committedClear.click();
  } else if (await drawingClear.isVisible()) {
    await drawingClear.click();
  }
  await expect(page.locator("main.ink-shell")).toHaveAttribute(
    "data-input-state",
    "empty",
  );
}

export const test = base.extend<E2EFixtures & E2EOptions>({
  modelResponseDelayMs: [0, { option: true }],
  readyPath: ["/", { option: true }],
  readyPage: [
    async ({ context, modelResponseDelayMs, page, readyPath }, run) => {
      const setupStartedAt = Date.now();
      if (modelResponseDelayMs > 0) {
        await context.route(
          "**/models/digits-crnn.onnx",
          async (route) => {
            await new Promise((resolve) =>
              setTimeout(resolve, modelResponseDelayMs),
            );
            await route.continue();
          },
          { times: 1 },
        );
      }
      await page.goto(readyPath);
      await waitForRecognizerState(page, "ready");
      await resetSurface(page);
      readinessSetupDurations.set(page, Date.now() - setupStartedAt);
      await run(page);
    },
    { timeout: MODEL_READY_TIMEOUT_MS },
  ],
  readinessSetupMs: async ({ readyPage }, run) => {
    await run(readinessSetupDurations.get(readyPage) ?? 0);
  },
});

export { expect };
