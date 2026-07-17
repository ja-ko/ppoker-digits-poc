import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import metadata from "../public/models/digits-crnn.json";
import { verifyModelBytes } from "../src/recognition/worker";

const model = await readFile(
  new URL("../public/models/digits-crnn.onnx", import.meta.url),
);

describe("committed recognition model integrity", () => {
  it("accepts the actual artifact against committed size and SHA-256", () => {
    expect(verifyModelBytes(model, metadata.model)).toHaveLength(
      metadata.model.bytes,
    );
  });

  it("rejects a wrong byte length before hashing", () => {
    expect(() => verifyModelBytes(model.subarray(1), metadata.model)).toThrow(
      "model byte length",
    );
  });

  it("rejects changed model bytes", () => {
    const changed = Uint8Array.from(model);
    changed[0] ^= 1;
    expect(() => verifyModelBytes(changed, metadata.model)).toThrow(
      "model SHA-256",
    );
  });

  it("rejects an incorrect expected hash", () => {
    expect(() =>
      verifyModelBytes(model, {
        bytes: metadata.model.bytes,
        sha256: "0".repeat(64),
      }),
    ).toThrow("model SHA-256");
  });
});
