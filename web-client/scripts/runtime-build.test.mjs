import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("recognition production bundle", () => {
  it("emits a module worker with base-relative external WASM URLs", async () => {
    const output = await mkdtemp(join(tmpdir(), "ppoker-recognition-build-"));
    const priorBase = process.env.VITE_BASE_PATH;
    process.env.VITE_BASE_PATH = "/nested-runtime/";
    try {
      await build({
        root,
        logLevel: "silent",
        publicDir: false,
        build: {
          emptyOutDir: true,
          outDir: output,
          lib: {
            entry: join(root, "src/recognition/client.ts"),
            fileName: "recognition-client",
            formats: ["es"],
          },
        },
      });

      const files = await readdir(output, { recursive: true });
      const clientFile = files.find((file) =>
        file.endsWith("recognition-client.js"),
      );
      const workerFile = files.find((file) => /worker-.*\.js$/.test(file));
      expect(clientFile).toBeDefined();
      expect(workerFile).toBeDefined();

      const client = await readFile(join(output, clientFile), "utf8");
      const worker = await readFile(join(output, workerFile), "utf8");
      expect(client).toContain("/nested-runtime/");
      expect(client).toMatch(/\/nested-runtime\/.*worker-.*\.js/);
      expect(worker).toContain("ort/ort-wasm-simd-threaded.mjs");
      expect(worker).toContain("ort/ort-wasm-simd-threaded.wasm");
      expect(worker).toContain("models/digits-crnn.json");
    } finally {
      if (priorBase === undefined) delete process.env.VITE_BASE_PATH;
      else process.env.VITE_BASE_PATH = priorBase;
      await rm(output, { force: true, recursive: true });
    }
  }, 30_000);
});
