import { expect, test } from "./fixtures";
import { CONFIDENCE_CORPUS } from "./confidence-corpus";
import { drawTemplate } from "./strokes";

test.describe("POC browser confidence corpus", () => {
  test.use({ readyPath: "/?diagnostics=1" });

  for (const corpusCase of CONFIDENCE_CORPUS) {
    test(corpusCase.name, async ({ readyPage }) => {
      if (corpusCase.viewport) {
        await readyPage.setViewportSize(corpusCase.viewport);
      }
      await readyPage.getByRole("button", { name: "Inspect" }).click();
      await readyPage.getByRole("button", { name: "Close" }).click();
      await drawTemplate(readyPage, corpusCase.strokes);
      await readyPage.waitForTimeout(750);

      const diagnosticValue = (label: string) =>
        readyPage
          .locator(".diagnostics-grid > div")
          .filter({ hasText: new RegExp(`^${label}`) })
          .locator("dd");
      await expect(diagnosticValue("raw text")).toHaveText(
        corpusCase.expected.raw,
      );
      await expect(diagnosticValue("greedy text")).toHaveText(
        corpusCase.expected.greedy,
      );
      await expect(diagnosticValue("threshold pass")).toHaveText(
        corpusCase.expected.thresholdPass,
      );
      const confidence = await diagnosticValue("confidence").textContent();
      if (corpusCase.expected.confidence === null) {
        expect(confidence).toBe("-");
      } else {
        expect(Number(confidence)).toBeCloseTo(
          corpusCase.expected.confidence,
          4,
        );
      }

      const output = readyPage.locator("output");
      if (corpusCase.expected.commit === undefined) {
        return;
      }
      if (corpusCase.expected.commit !== null) {
        await expect(output).toHaveText(corpusCase.expected.commit);
        await expect(readyPage.locator("main.ink-shell")).toHaveAttribute(
          "data-input-state",
          "committed",
        );
      } else {
        await expect(output).toHaveCount(0);
        await readyPage.waitForTimeout(500);
        await expect(output).toHaveCount(0);
      }
    });
  }
});
