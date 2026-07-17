import type { Page } from "@playwright/test";

import { settlePaint } from "./canvas";
import { expect, test } from "./fixtures";
import { drawCard } from "./strokes";

async function settleVisualState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await settlePaint(page);
}

const visualTest = test.extend<{ visualPage: Page }>({
  visualPage: async ({ readyPage }, run) => {
    await readyPage.waitForFunction(
      () => document.fonts.status === "loaded",
      undefined,
      { timeout: 1_000 },
    );
    await readyPage.addStyleTag({
      content: `
        *, *::before, *::after {
          caret-color: transparent !important;
          transition: none !important;
        }
      `,
    });
    await settleVisualState(readyPage);
    await run(readyPage);
  },
});

visualTest("empty portrait surface", async ({ visualPage }) => {
  await expect(visualPage.locator("main.ink-shell")).toHaveAttribute(
    "data-input-state",
    "empty",
  );
  await settleVisualState(visualPage);
  await expect(visualPage.locator(".writing-guide")).toHaveScreenshot(
    "empty-portrait.png",
    {
      animations: "disabled",
      caret: "hide",
    },
  );
});

visualTest("committed result", async ({ visualPage }) => {
  await drawCard(visualPage, "5");
  await expect(visualPage.locator("main.ink-shell")).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(visualPage.locator("main.ink-shell")).toHaveAttribute(
    "data-input-state",
    "committed",
  );
  await expect(visualPage.locator("output")).toHaveText("5");
  await settleVisualState(visualPage);
  await expect(visualPage).toHaveScreenshot("committed-five.png", {
    animations: "disabled",
    caret: "hide",
  });
});
