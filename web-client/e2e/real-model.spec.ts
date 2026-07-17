import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { CARD_STROKES, drawCard, drawMouseStroke } from "./strokes";

const shell = (page: Page) => page.locator("main.ink-shell");

async function expectCommitted(page: Page, value: string): Promise<void> {
  await page.waitForTimeout(100);
  await expect(shell(page)).toHaveAttribute("data-input-state", "committing");
  await expect(shell(page)).toHaveAttribute("data-input-state", "committed");
  await expect(page.locator("output")).toHaveText(value);
  await expect(page.locator("output")).toHaveAttribute(
    "aria-label",
    `Committed vote ${value}`,
  );
}

test("production root loads the real worker and model", async ({
  readyPage,
}) => {
  await expect(readyPage).toHaveURL(/\/$/);
  await expect(shell(readyPage)).toHaveAttribute(
    "data-recognizer-state",
    "ready",
  );
  await expect(
    readyPage.getByRole("region", { name: /Handwriting surface/ }),
  ).toHaveAttribute("aria-disabled", "false");
  await expect(readyPage.getByText("Preparing local recognition")).toHaveCount(
    0,
  );
  await expect(
    readyPage.getByRole("link", { name: "Notices", exact: true }),
  ).toHaveAttribute("href", "/legal/THIRD_PARTY_NOTICES.txt");
});

for (const value of ["1", "2", "3", "5", "8", "13"] as const) {
  test(`real raster, worker, and default deck commit ${value}`, async ({
    readyPage,
  }) => {
    await drawCard(readyPage, value, value === "1");
    await expectCommitted(readyPage, value);
  });
}

test.describe("diagnostic prefix timing", () => {
  test.use({ readyPath: "/?diagnostics=1" });

  test("a second stroke cancels the pending 1 and commits 13", async ({
    readyPage,
  }) => {
    await readyPage.getByRole("button", { name: "Inspect" }).click();
    await readyPage.getByRole("button", { name: "Close" }).click();

    await drawMouseStroke(readyPage, CARD_STROKES["13"][0]);
    await readyPage.waitForTimeout(750);
    await expect(shell(readyPage)).toHaveAttribute(
      "data-input-state",
      "settling",
    );
    await expect(
      readyPage
        .locator(".diagnostics-grid > div")
        .filter({ hasText: /^raw text/ })
        .locator("dd"),
    ).toHaveText("1");
    await expect(readyPage.locator("output")).toHaveCount(0);

    await drawMouseStroke(readyPage, CARD_STROKES["13"][1]);
    await expect(shell(readyPage)).toHaveAttribute(
      "data-input-state",
      "settling",
    );
    await expect(readyPage.locator("output")).toHaveCount(0);
    await expectCommitted(readyPage, "13");
  });
});
