import { expect, test } from "./fixtures";

test("model load failure is explicit and retry restores the real worker", async ({
  context,
  page,
}) => {
  const metadata = "**/models/digits-crnn.json";
  await context.route(metadata, async (route) => route.abort("failed"));
  await page.goto("/");
  await expect(page.locator("main.ink-shell")).toHaveAttribute(
    "data-recognizer-state",
    "failed",
  );

  await expect(page.getByText("Recognition unavailable")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry recognizer" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: /Handwriting surface/ }),
  ).toHaveAttribute("aria-disabled", "true");

  await context.unroute(metadata);
  await page.getByRole("button", { name: "Retry recognizer" }).click();
  await expect(page.locator("main.ink-shell")).toHaveAttribute(
    "data-recognizer-state",
    "ready",
  );
  await expect(
    page.getByRole("region", { name: /Handwriting surface/ }),
  ).toHaveAttribute("aria-disabled", "false");
});

test.describe("model readiness fixture boundary", () => {
  test.use({ modelResponseDelayMs: 12_100 });

  test("allows model setup beyond twelve seconds", async ({
    readinessSetupMs,
    readyPage,
  }) => {
    expect(readinessSetupMs).toBeGreaterThanOrEqual(12_100);
    await expect(readyPage.locator("main.ink-shell")).toHaveAttribute(
      "data-recognizer-state",
      "ready",
    );
    await expect(
      readyPage.getByRole("region", { name: /Handwriting surface/ }),
    ).toHaveAttribute("aria-disabled", "false");
  });
});
