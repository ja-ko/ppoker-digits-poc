import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  localLegalAssets,
  remoteLegalAssets,
  sha256,
} from "./copy-legal-assets.mjs";

describe("distribution legal assets", () => {
  it.each(localLegalAssets)("copies %s byte-for-byte", async (source, name) => {
    const [authoritative, generated] = await Promise.all([
      readFile(source),
      readFile(new URL(`../public/legal/${name}`, import.meta.url)),
    ]);
    expect(sha256(generated)).toBe(sha256(authoritative));
  });

  it.each(remoteLegalAssets)(
    "preserves the pinned $name",
    async ({ name, sha256: expected }) => {
      const generated = await readFile(
        new URL(`../public/legal/${name}`, import.meta.url),
      );
      expect(sha256(generated)).toBe(expected);
    },
  );

  it("records why ONNX Runtime npm transitives are not separate notices", async () => {
    const sourceMap = JSON.parse(
      await readFile(
        new URL(
          "../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs.map",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(sourceMap.sources).not.toHaveLength(0);
    expect(
      sourceMap.sources.every(
        (source) =>
          source.startsWith("../../common/") || source.startsWith("../lib/"),
      ),
    ).toBe(true);
  });
});
