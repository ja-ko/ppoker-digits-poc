import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const assets = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("ONNX Runtime assets", () => {
  it.each(assets)(
    "copies the locked package's %s byte-for-byte",
    async (asset) => {
      const installed = await readFile(
        fileURLToPath(import.meta.resolve(`onnxruntime-web/${asset}`)),
      );
      const generated = await readFile(
        new URL(`../public/ort/${asset}`, import.meta.url),
      );
      expect(generated.byteLength).toBe(installed.byteLength);
      expect(sha256(generated)).toBe(sha256(installed));
    },
  );
});
