import type { Locator, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { canvasInkSnapshot, settlePaint } from "./canvas";
import {
  cancelActiveMousePointer,
  CARD_STROKES,
  drawCard,
  drawMouseStroke,
  drawTemplate,
  pointerDownAtSurfaceEdge,
  startMouseStroke,
} from "./strokes";

const shell = (page: Page) => page.locator("main.ink-shell");
test.use({ readyPath: "/?diagnostics=1" });

async function openDiagnostics(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Inspect" }).click();
}

function diagnosticValue(page: Page, label: string): Locator {
  return page
    .locator(".diagnostics-grid > div")
    .filter({ hasText: new RegExp(`^${label}`) })
    .locator("dd");
}

interface EffectCapture {
  readonly inkEffect: string;
  readonly canvas: {
    readonly animationName: string;
    readonly filter: string;
    readonly transform: string;
    readonly keyframes: readonly {
      readonly filter: string | null;
      readonly opacity: string | null;
      readonly transform: string | null;
    }[];
  };
  readonly output: {
    readonly animationName: string;
    readonly filter: string;
    readonly keyframes: readonly {
      readonly filter: string | null;
      readonly opacity: string | null;
      readonly transform: string | null;
    }[];
  } | null;
}

async function armEffectCapture(
  page: Page,
  expectedState: "committing" | "rejecting",
): Promise<void> {
  await page.evaluate((state) => {
    const effectWindow = window as typeof window & {
      __effectCapture?: EffectCapture | null;
    };
    effectWindow.__effectCapture = null;
    const root = document.querySelector<HTMLElement>("main.ink-shell")!;
    const captureAnimation = (element: Element) => {
      const style = getComputedStyle(element);
      const keyframes = element.getAnimations().flatMap((animation) => {
        const effect = animation.effect;
        return effect instanceof KeyframeEffect
          ? effect.getKeyframes().map((frame) => ({
              filter: typeof frame.filter === "string" ? frame.filter : null,
              opacity: typeof frame.opacity === "string" ? frame.opacity : null,
              transform:
                typeof frame.transform === "string" ? frame.transform : null,
            }))
          : [];
      });
      return {
        animationName: style.animationName,
        filter: style.filter,
        transform: style.transform,
        keyframes,
      };
    };
    const capture = () => {
      if (root.dataset.inputState !== state) {
        return;
      }
      const canvas = root.querySelector("canvas.ink-canvas")!;
      const output = root.querySelector("output");
      effectWindow.__effectCapture = {
        inkEffect: root.dataset.inkEffect ?? "none",
        canvas: captureAnimation(canvas),
        output: output ? captureAnimation(output) : null,
      };
      observer.disconnect();
      root.removeEventListener("animationstart", capture);
    };
    const observer = new MutationObserver(capture);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-input-state"],
    });
    root.addEventListener("animationstart", capture);
  }, expectedState);
}

async function capturedEffect(page: Page): Promise<EffectCapture> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (
            window as typeof window & {
              __effectCapture?: EffectCapture | null;
            }
          ).__effectCapture,
        ),
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __effectCapture: EffectCapture;
        }
      ).__effectCapture,
  );
}

test("the guide bounds input and deck labels do not start ink", async ({
  readyPage,
}) => {
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
  await expect(diagnosticValue(readyPage, "strokes / points")).toHaveText(
    "0 / 0",
  );

  await readyPage.mouse.move(
    surfaceBox!.x + surfaceBox!.width / 2,
    surfaceBox!.y - 8,
  );
  await readyPage.mouse.down();
  await readyPage.mouse.up();
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");

  await readyPage.mouse.move(surfaceBox!.x + 30, surfaceBox!.y + 30);
  await readyPage.mouse.down();
  await readyPage.mouse.move(surfaceBox!.x + 90, surfaceBox!.y + 90);
  await readyPage.mouse.move(surfaceBox!.x - 15, surfaceBox!.y + 100);
  await readyPage.mouse.move(surfaceBox!.x + 140, surfaceBox!.y + 140);
  await readyPage.mouse.up();
  await expect(diagnosticValue(readyPage, "strokes / points")).toHaveText(
    /^2 \/ /,
  );
});

test("pointerdown at an edge cancels commit and restores ink", async ({
  readyPage,
}) => {
  await drawCard(readyPage, "5");
  await settlePaint(readyPage);
  const beforeEffect = await canvasInkSnapshot(readyPage);
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );

  await pointerDownAtSurfaceEdge(readyPage);
  await cancelActiveMousePointer(readyPage);
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");
  await settlePaint(readyPage);
  const restored = await canvasInkSnapshot(readyPage);
  expect(restored).toEqual(beforeEffect);
  expect(restored.alphaPixels).toBeGreaterThan(0);
});

test("pointerdown at an edge cancels rejection and restores ink", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  await readyPage
    .getByRole("textbox", { name: "Numeric mock deck" })
    .fill("1, 2, 3, 8, 13");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await drawCard(readyPage, "5");
  await settlePaint(readyPage);
  const beforeEffect = await canvasInkSnapshot(readyPage);
  await readyPage.waitForTimeout(650);
  await expect(diagnosticValue(readyPage, "raw text")).toHaveText("5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "rejecting",
  );

  await pointerDownAtSurfaceEdge(readyPage);
  await cancelActiveMousePointer(readyPage);
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");
  await settlePaint(readyPage);
  const restored = await canvasInkSnapshot(readyPage);
  expect(restored).toEqual(beforeEffect);
  expect(restored.alphaPixels).toBeGreaterThan(0);
});

test("clear locks, keyboard-unlocks, restores focus, and permits reuse", async ({
  readyPage,
}) => {
  const surface = readyPage.getByRole("region", {
    name: /Handwriting surface/,
  });
  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
  await expect(surface).toHaveAttribute("aria-disabled", "true");

  const clear = readyPage.getByRole("button", { name: "Clear and try again" });
  await clear.focus();
  await readyPage.keyboard.press("Enter");
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");
  await expect(surface).toHaveAttribute("aria-disabled", "false");
  await expect(surface).toBeFocused();

  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
});

test("default threshold commits 13 while threshold and deck guards remain active", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  const threshold = readyPage.getByRole("spinbutton", {
    name: "POC browser confidence threshold",
  });
  await expect(threshold).toHaveValue("0.95");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await drawCard(readyPage, "13");
  await readyPage.waitForTimeout(100);
  await expect(diagnosticValue(readyPage, "threshold pass")).toHaveText("yes");
  await expect(readyPage.locator(".decision-debug")).toContainText("commit 13");
  await expect(readyPage.locator(".decision-debug")).toContainText("in deck");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );

  await readyPage.getByRole("button", { name: "Clear and try again" }).click();
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");
  await readyPage.getByRole("button", { name: "Inspect" }).click();
  await threshold.fill("1");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await drawCard(readyPage, "5");
  await readyPage.waitForTimeout(650);
  await expect(diagnosticValue(readyPage, "raw text")).toHaveText("5");
  await expect(diagnosticValue(readyPage, "threshold pass")).toHaveText("no");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "rejecting",
  );
  await expect(readyPage.locator(".decision-debug")).toContainText(
    "reject unclaimed",
  );
  await expect(readyPage.locator(".decision-debug")).toContainText("likely 5");
  await expect(readyPage.locator(".decision-debug")).toContainText("in deck");
  await expect(readyPage.locator("output")).toHaveCount(0);
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "empty");

  await readyPage.getByRole("button", { name: "Inspect" }).click();
  await threshold.fill("0.95");
  const deck = readyPage.getByRole("textbox", { name: "Numeric mock deck" });
  await deck.fill("01, 1, 2, 3, 8, 13, 256, coffee, 13");
  await expect(readyPage.locator(".diagnostics-deck-result")).toContainText(
    "accepted: 1, 2, 3, 8, 13",
  );
  await expect(readyPage.locator(".diagnostics-deck-result")).toContainText(
    "rejected: 01, 256, coffee",
  );
  await readyPage.getByRole("button", { name: "Close" }).click();
  await drawCard(readyPage, "5");
  await readyPage.waitForTimeout(650);
  await expect(diagnosticValue(readyPage, "raw text")).toHaveText("5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "rejecting",
  );
  await expect(readyPage.locator(".decision-debug")).toContainText(
    "not in deck",
  );
  await expect(readyPage.locator("output")).toHaveCount(0);
});

test("full-motion low-confidence rejection uses the shake choreography", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  await readyPage
    .getByRole("spinbutton", { name: "POC browser confidence threshold" })
    .fill("1");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await armEffectCapture(readyPage, "rejecting");
  await drawCard(readyPage, "5");
  await readyPage.waitForTimeout(300);
  const capture = await capturedEffect(readyPage);
  expect(capture.inkEffect).toBe("reject");
  expect(capture.canvas.animationName).toBe("ink-reject");
  expect(
    new Set(capture.canvas.keyframes.map((frame) => frame.transform)).size,
  ).toBeGreaterThan(2);
});

test("full-motion commit translates off-center ink to the result center", async ({
  readyPage,
}) => {
  const offCenterFive = CARD_STROKES["5"].map((stroke) =>
    stroke.map((point) => ({
      x: 0.3 + (point.x - 0.5) * 0.45,
      y: point.y,
    })),
  );
  await armEffectCapture(readyPage, "committing");
  await drawTemplate(readyPage, offCenterFive);
  const capture = await capturedEffect(readyPage);
  expect(capture.inkEffect).toBe("resolve");
  expect(capture.canvas.animationName).toBe("ink-resolve");

  const settleOffset = await shell(readyPage).evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      x: Number.parseFloat(style.getPropertyValue("--ink-settle-x")),
      y: Number.parseFloat(style.getPropertyValue("--ink-settle-y")),
    };
  });
  expect(Math.hypot(settleOffset.x, settleOffset.y)).toBeGreaterThan(20);
  const finalTransform = capture.canvas.keyframes.at(-1)?.transform;
  expect(finalTransform).not.toBeNull();
  const endpoint = await readyPage.evaluate((transform) => {
    const matrix = new DOMMatrix(transform ?? "none");
    return { x: matrix.e, y: matrix.f };
  }, finalTransform);
  expect(endpoint.x).toBeCloseTo(settleOffset.x, 1);
  expect(endpoint.y).toBeCloseTo(settleOffset.y, 1);
});

test("diagnostics collapse, expand, avoid clear, and cancel benchmark", async ({
  readyPage,
}) => {
  const diagnostics = readyPage.getByRole("complementary", {
    name: "Recognition diagnostics",
  });
  const inspector = diagnostics.locator(".diagnostics-inspector");
  await expect(diagnostics).toHaveAttribute("data-expanded", "false");
  await expect(inspector).toBeHidden();
  await diagnostics.getByRole("button", { name: "Inspect" }).click();
  await expect(inspector).toBeVisible();
  await diagnostics.getByRole("button", { name: "Close" }).click();
  await expect(inspector).toBeHidden();

  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
  const clear = readyPage.getByRole("button", { name: "Clear and try again" });
  const [diagnosticsBox, clearBox] = await Promise.all([
    diagnostics.boundingBox(),
    clear.boundingBox(),
  ]);
  expect(diagnosticsBox).not.toBeNull();
  expect(clearBox).not.toBeNull();
  expect(
    diagnosticsBox!.x + diagnosticsBox!.width <= clearBox!.x ||
      clearBox!.x + clearBox!.width <= diagnosticsBox!.x ||
      diagnosticsBox!.y + diagnosticsBox!.height <= clearBox!.y ||
      clearBox!.y + clearBox!.height <= diagnosticsBox!.y,
  ).toBe(true);

  await diagnostics.getByRole("button", { name: "Inspect" }).click();
  const run = diagnostics.getByRole("button", { name: "Run benchmark" });
  await expect(run).toBeEnabled();
  await run.click();
  const cancel = diagnostics.getByRole("button", { name: /^Cancel/ });
  await expect(cancel).toBeVisible();
  await cancel.click();
  await expect(run).toBeVisible();
});

test("normal notices link stays accessible at 280px with diagnostics and clear", async ({
  readyPage,
}) => {
  await readyPage.setViewportSize({ width: 280, height: 653 });
  const notices = readyPage.getByRole("link", { name: "Notices", exact: true });
  await expect(notices).toBeVisible();
  await expect(notices).toHaveAttribute(
    "href",
    "/legal/THIRD_PARTY_NOTICES.txt",
  );
  await notices.focus();
  await expect(notices).toBeFocused();

  const href = await notices.getAttribute("href");
  const response = await readyPage.request.get(href!);
  expect(response.ok()).toBe(true);
  expect(await response.text()).toContain("ppoker handwriting POC");

  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
  const clear = readyPage.getByRole("button", { name: "Clear and try again" });
  const diagnostics = readyPage.getByRole("complementary", {
    name: "Recognition diagnostics",
  });
  await diagnostics.getByRole("button", { name: "Inspect" }).click();
  await expect(diagnostics).toHaveAttribute("data-expanded", "true");
  const [noticesBox, clearBox, diagnosticsBox] = await Promise.all([
    notices.boundingBox(),
    clear.boundingBox(),
    diagnostics.boundingBox(),
  ]);
  expect(noticesBox).not.toBeNull();
  expect(clearBox).not.toBeNull();
  expect(diagnosticsBox).not.toBeNull();
  expect(noticesBox!.x).toBeGreaterThanOrEqual(0);
  expect(noticesBox!.y).toBeGreaterThanOrEqual(0);
  expect(noticesBox!.x + noticesBox!.width).toBeLessThanOrEqual(280);
  expect(noticesBox!.y + noticesBox!.height).toBeLessThanOrEqual(653);
  for (const other of [clearBox!, diagnosticsBox!]) {
    expect(
      noticesBox!.x + noticesBox!.width <= other.x ||
        other.x + other.width <= noticesBox!.x ||
        noticesBox!.y + noticesBox!.height <= other.y ||
        other.y + other.height <= noticesBox!.y,
    ).toBe(true);
  }

  const dimensions = await readyPage.evaluate(() => ({
    innerWidth,
    innerHeight,
    documentWidth: document.documentElement.scrollWidth,
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.innerHeight);
});

test("reduced motion commit uses stable opacity-only keyframes", async ({
  readyPage,
}) => {
  await readyPage.emulateMedia({ reducedMotion: "reduce" });
  await armEffectCapture(readyPage, "committing");
  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
  const capture = await capturedEffect(readyPage);
  expect(capture.inkEffect).toBe("resolve");
  expect(capture.canvas.animationName).toBe("ink-opacity-only");
  expect(capture.canvas.filter).toBe("none");
  expect(capture.canvas.transform).toBe("none");
  expect(capture.canvas.keyframes.every((frame) => frame.filter === null)).toBe(
    true,
  );
  expect(
    capture.canvas.keyframes.every((frame) => frame.transform === null),
  ).toBe(true);
  expect(capture.output?.animationName).toBe("result-opacity-only");
  expect(capture.output?.filter).toBe("none");
  expect(
    new Set(capture.output?.keyframes.map((frame) => frame.transform)).size,
  ).toBe(1);
  await expect(readyPage.locator("output")).toBeVisible();
});

test("reduced motion invalid input suppresses transform and shake keyframes", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  await readyPage
    .getByRole("textbox", { name: "Numeric mock deck" })
    .fill("1, 2, 3, 8, 13");
  await readyPage.getByRole("button", { name: "Close" }).click();
  await readyPage.emulateMedia({ reducedMotion: "reduce" });
  await armEffectCapture(readyPage, "rejecting");
  await drawCard(readyPage, "5");
  await readyPage.waitForTimeout(300);

  const capture = await capturedEffect(readyPage);
  expect(capture.inkEffect).toBe("reject");
  expect(capture.canvas.animationName).toBe("ink-opacity-only");
  expect(capture.canvas.filter).toBe("none");
  expect(capture.canvas.transform).toBe("none");
  expect(capture.canvas.keyframes.every((frame) => frame.filter === null)).toBe(
    true,
  );
  expect(
    capture.canvas.keyframes.every((frame) => frame.transform === null),
  ).toBe(true);
});

test("resize, orientation, and DPR preserve ink and the committed locus", async ({
  readyPage,
}) => {
  const session = await readyPage.context().newCDPSession(readyPage);
  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    });
    await settlePaint(readyPage);
    const offCenterFive = CARD_STROKES["5"].map((stroke) =>
      stroke.map((point) => ({
        x: 0.23 + (point.x - 0.5) * 0.4,
        y: 0.5 + (point.y - 0.525) * 1.2,
      })),
    );
    await drawTemplate(readyPage, offCenterFive);
    await settlePaint(readyPage);

    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    });
    await settlePaint(readyPage);
    const rotatedInk = await canvasInkSnapshot(readyPage);
    expect(rotatedInk.alphaPixels).toBeGreaterThan(0);
    expect(rotatedInk.logicalCenter).not.toBeNull();

    await expect(shell(readyPage)).toHaveAttribute(
      "data-input-state",
      "committing",
    );
    const settleOffset = await shell(readyPage).evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        x: Number.parseFloat(style.getPropertyValue("--ink-settle-x")),
        y: Number.parseFloat(style.getPropertyValue("--ink-settle-y")),
      };
    });
    expect(Math.hypot(settleOffset.x, settleOffset.y)).toBeGreaterThan(20);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 391,
      height: 844,
      deviceScaleFactor: 2,
      mobile: false,
      screenOrientation: { type: "portraitPrimary", angle: 0 },
    });
    await expect
      .poll(async () => {
        const metrics = await readyPage
          .locator("canvas.ink-canvas")
          .evaluate((canvas: HTMLCanvasElement) => ({
            backingWidth: canvas.width,
            cssWidth: canvas.getBoundingClientRect().width,
            dpr: window.devicePixelRatio,
          }));
        return (
          metrics.dpr === 2 &&
          metrics.backingWidth === Math.round(metrics.cssWidth * metrics.dpr)
        );
      })
      .toBe(true);
    const canvasMetrics = await readyPage
      .locator("canvas.ink-canvas")
      .evaluate((canvas: HTMLCanvasElement) => ({
        backingWidth: canvas.width,
        cssWidth: canvas.getBoundingClientRect().width,
        dpr: window.devicePixelRatio,
      }));
    expect(canvasMetrics.dpr).toBe(2);
    expect(canvasMetrics.backingWidth).toBe(
      Math.round(canvasMetrics.cssWidth * canvasMetrics.dpr),
    );
    expect(canvasMetrics.cssWidth).toBeLessThan(391);

    await expect(shell(readyPage)).toHaveAttribute(
      "data-input-state",
      "committed",
    );
    const [portraitResult, portraitSurface] = await Promise.all([
      readyPage.locator("output").boundingBox(),
      readyPage
        .getByRole("region", { name: /Handwriting surface/ })
        .boundingBox(),
    ]);
    expect(portraitResult).not.toBeNull();
    expect(portraitSurface).not.toBeNull();
    expect(
      Math.abs(
        portraitResult!.x +
          portraitResult!.width / 2 -
          (portraitSurface!.x + portraitSurface!.width / 2),
      ),
    ).toBeLessThan(3);
    expect(
      Math.abs(
        portraitResult!.y +
          portraitResult!.height / 2 -
          (portraitSurface!.y + portraitSurface!.height / 2),
      ),
    ).toBeLessThan(3);

    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: false,
      screenOrientation: { type: "landscapePrimary", angle: 90 },
    });
    await settlePaint(readyPage);
    const [result, landscapeSurface] = await Promise.all([
      readyPage.locator("output").boundingBox(),
      readyPage
        .getByRole("region", { name: /Handwriting surface/ })
        .boundingBox(),
    ]);
    expect(result).not.toBeNull();
    expect(landscapeSurface).not.toBeNull();
    expect(
      Math.abs(
        result!.x +
          result!.width / 2 -
          (landscapeSurface!.x + landscapeSurface!.width / 2),
      ),
    ).toBeLessThan(3);
    expect(
      Math.abs(
        result!.y +
          result!.height / 2 -
          (landscapeSurface!.y + landscapeSurface!.height / 2),
      ),
    ).toBeLessThan(3);
    expect(result!.x).toBeGreaterThanOrEqual(0);
    expect(result!.y).toBeGreaterThanOrEqual(0);
    expect(result!.x + result!.width).toBeLessThanOrEqual(844);
    expect(result!.y + result!.height).toBeLessThanOrEqual(390);
    await expect(readyPage.locator("output")).toBeVisible();
  } finally {
    await session.detach();
  }
});

test("orientationchange cancels an active stroke before fresh input succeeds", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  await readyPage.getByRole("button", { name: "Close" }).click();
  await startMouseStroke(readyPage, [
    { x: 0.42, y: 0.38 },
    { x: 0.52, y: 0.58 },
  ]);
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");

  await readyPage.evaluate(() =>
    window.dispatchEvent(new Event("orientationchange")),
  );
  await settlePaint(readyPage);
  await readyPage.mouse.up();
  await expect(diagnosticValue(readyPage, "strokes / points")).toHaveText(
    "0 / 0",
  );
  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
});

test("resize cancels an active stroke before fresh input succeeds", async ({
  readyPage,
}) => {
  await openDiagnostics(readyPage);
  await readyPage.getByRole("button", { name: "Close" }).click();
  await startMouseStroke(readyPage, [
    { x: 0.42, y: 0.38 },
    { x: 0.52, y: 0.58 },
  ]);
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");

  await readyPage.setViewportSize({ width: 844, height: 390 });
  await settlePaint(readyPage);
  await readyPage.mouse.up();
  await expect(diagnosticValue(readyPage, "strokes / points")).toHaveText(
    "0 / 0",
  );
  await expect(shell(readyPage)).toHaveAttribute("data-input-state", "drawing");

  await readyPage.setViewportSize({ width: 390, height: 844 });
  await settlePaint(readyPage);
  await drawCard(readyPage, "5");
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committing",
  );
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "committed",
  );
});

test("280px portrait and short landscape have no page overflow", async ({
  readyPage,
}) => {
  for (const viewport of [
    { width: 280, height: 653 },
    { width: 844, height: 390 },
  ]) {
    await readyPage.setViewportSize(viewport);
    await readyPage.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const dimensions = await readyPage.evaluate(() => ({
      innerWidth,
      innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      bodyWidth: document.body.scrollWidth,
      bodyHeight: document.body.scrollHeight,
    }));
    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.innerWidth);
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.innerWidth);
    expect(dimensions.documentHeight).toBeLessThanOrEqual(
      dimensions.innerHeight,
    );
    expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.innerHeight);
  }

  await drawMouseStroke(readyPage, [
    { x: 0.4, y: 0.35 },
    { x: 0.6, y: 0.65 },
  ]);
  await expect(shell(readyPage)).toHaveAttribute(
    "data-input-state",
    "settling",
  );
});
