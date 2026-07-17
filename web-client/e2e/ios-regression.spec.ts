import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { CARD_STROKES, drawCard, drawMouseStroke } from "./strokes";

const shell = (page: Page) => page.locator("main.ink-shell");

test.use({ readyPath: "/?diagnostics=1" });

test("writing is bounded and deck labels are inert", async ({ readyPage }) => {
  const surface = readyPage.getByRole("region", {
    name: /Handwriting surface/,
  });
  const [surfaceBox, guideBox] = await Promise.all([
    surface.boundingBox(),
    readyPage.locator(".writing-guide").boundingBox(),
  ]);
  expect(surfaceBox).not.toBeNull();
  expect(guideBox).not.toBeNull();
  expect(surfaceBox).toEqual(guideBox);

  await readyPage.locator(".mock-deck span").filter({ hasText: /^5$/ }).click();
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");

  await readyPage.mouse.move(
    surfaceBox!.x + surfaceBox!.width / 2,
    surfaceBox!.y - 8,
  );
  await readyPage.mouse.down();
  await readyPage.mouse.up();
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");
});

test("committed output is centered and reports its confidence", async ({
  readyPage,
}) => {
  const offCenterFive = CARD_STROKES["5"][0].map((point) => ({
    x: 0.3 + (point.x - 0.5) * 0.45,
    y: point.y,
  }));
  await drawMouseStroke(readyPage, offCenterFive);
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
    { timeout: 2_000 },
  );

  const [result, surface] = await Promise.all([
    readyPage.locator("output").boundingBox(),
    readyPage
      .getByRole("region", { name: /Handwriting surface/ })
      .boundingBox(),
  ]);
  expect(result).not.toBeNull();
  expect(surface).not.toBeNull();
  expect(
    Math.abs(result!.x + result!.width / 2 - (surface!.x + surface!.width / 2)),
  ).toBeLessThan(3);
  expect(
    Math.abs(
      result!.y + result!.height / 2 - (surface!.y + surface!.height / 2),
    ),
  ).toBeLessThan(3);
  await expect(readyPage.locator(".decision-debug")).toContainText("commit 5");
  await expect(readyPage.locator(".decision-debug")).toContainText(
    /confidence 0\.\d{6}/,
  );
  await expect(readyPage.locator(".decision-debug")).toContainText("in deck");
});

test("low-confidence rejection shakes and reports the candidate", async ({
  readyPage,
}) => {
  await readyPage.getByRole("button", { name: "Inspect" }).click();
  await readyPage
    .getByRole("spinbutton", { name: "POC browser confidence threshold" })
    .fill("1");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "rejecting",
    { timeout: 2_000 },
  );
  await expect(shell(readyPage)).toHaveAttribute("data-ink-effect", "reject");
  await expect(readyPage.locator("canvas.ink-canvas")).toHaveCSS(
    "animation-name",
    "ink-reject",
  );
  await expect(readyPage.locator(".decision-debug")).toContainText(
    "reject unclaimed",
  );
  await expect(readyPage.locator(".decision-debug")).toContainText("likely 5");

  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty", {
    timeout: 1_000,
  });
  await readyPage.setViewportSize({ width: 844, height: 390 });
  const surface = await readyPage
    .getByRole("region", { name: /Handwriting surface/ })
    .boundingBox();
  expect(surface).not.toBeNull();
  const point = {
    x: surface!.x + surface!.width / 2,
    y: surface!.y + surface!.height - 5,
  };
  const targetClass = await readyPage.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.className,
    point,
  );
  expect(targetClass).toContain("ink-surface");
  await readyPage.mouse.move(point.x, point.y);
  await readyPage.mouse.down();
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");
  await readyPage.mouse.up();
});
