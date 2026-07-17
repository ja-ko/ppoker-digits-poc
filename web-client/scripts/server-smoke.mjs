import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { closePreview, startPreview } from "./preview-server.mjs";

const EXPECTED_MODEL_BYTES = 1_714_986;
const EXPECTED_MODEL_SHA256 =
  "bea69199be71c01a35f4485ad853ef6fd11608c616c452598cb3f330922db9af";
const base = "/handwriting-poc/";
const root = fileURLToPath(new URL("../", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const output = await mkdtemp(join(tmpdir(), "ppoker-poc-server-smoke-"));
let server;

try {
  await build({
    root,
    base,
    logLevel: "silent",
    build: { emptyOutDir: true, outDir: output },
  });

  const started = await startPreview(root, {
    base,
    build: { outDir: output },
  });
  server = started.server;
  const { origin } = started;

  async function fetchAsset(pathname, expectedType = null) {
    const response = await fetch(new URL(pathname, origin), {
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      response.status === 200,
      `${pathname} returned HTTP ${response.status}`,
    );
    if (expectedType) {
      const contentType =
        response.headers.get("content-type")?.toLowerCase() ?? "";
      assert(
        contentType.startsWith(expectedType),
        `${pathname} returned MIME ${contentType || "<missing>"}, expected ${expectedType}`,
      );
    }
    return response;
  }

  const index = await (await fetchAsset(base, "text/html")).text();
  const referencedAssets = [...index.matchAll(/(?:src|href)="([^"]+)"/g)].map(
    ([, value]) => new URL(value, `${origin}${base}`).pathname,
  );
  const entryPath = referencedAssets.find((value) => value.endsWith(".js"));
  const stylePath = referencedAssets.find((value) => value.endsWith(".css"));
  assert(entryPath, "built index did not reference an entry JavaScript asset");
  assert(stylePath, "built index did not reference a stylesheet asset");

  const entry = await (await fetchAsset(entryPath, "text/javascript")).text();
  await fetchAsset(stylePath, "text/css");
  const workerMatch = entry.match(
    /(?:\/handwriting-poc\/)?assets\/worker-[A-Za-z0-9_-]+\.js/,
  );
  assert(workerMatch, "entry asset did not reference the recognition worker");
  const workerPath = workerMatch[0].startsWith("/")
    ? workerMatch[0]
    : new URL(workerMatch[0], `${origin}${base}`).pathname;
  await fetchAsset(workerPath, "text/javascript");

  const metadata = await (
    await fetchAsset(`${base}models/digits-crnn.json`, "application/json")
  ).json();
  assert(
    metadata.model.bytes === EXPECTED_MODEL_BYTES,
    `metadata model size changed to ${metadata.model.bytes}`,
  );
  assert(
    metadata.model.sha256 === EXPECTED_MODEL_SHA256,
    `metadata model SHA-256 changed to ${metadata.model.sha256}`,
  );

  const model = Buffer.from(
    await (await fetchAsset(`${base}models/digits-crnn.onnx`)).arrayBuffer(),
  );
  assert(
    model.byteLength === EXPECTED_MODEL_BYTES,
    "served ONNX size is incorrect",
  );
  assert(
    createHash("sha256").update(model).digest("hex") === EXPECTED_MODEL_SHA256,
    "served ONNX SHA-256 is incorrect",
  );

  await fetchAsset(`${base}ort/ort-wasm-simd-threaded.mjs`, "text/javascript");
  await fetchAsset(
    `${base}ort/ort-wasm-simd-threaded.wasm`,
    "application/wasm",
  );

  console.log(
    `Server smoke passed at ${origin}${base} (nested base, entry, CSS, worker, model, and ORT assets).`,
  );
} finally {
  const cleanupErrors = [];
  try {
    if (server) await closePreview(server);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(output, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "server smoke cleanup failed");
  }
}
