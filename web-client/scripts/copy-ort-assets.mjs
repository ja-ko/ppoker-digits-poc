import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const assets = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const installedPackage = JSON.parse(
  await readFile(
    new URL("../node_modules/onnxruntime-web/package.json", import.meta.url),
    "utf8",
  ),
);

if (installedPackage.version !== packageJson.dependencies["onnxruntime-web"]) {
  throw new Error(
    `onnxruntime-web ${installedPackage.version} does not match lock ${packageJson.dependencies["onnxruntime-web"]}`,
  );
}

const destination = fileURLToPath(new URL("../public/ort/", import.meta.url));
await rm(destination, { force: true, recursive: true });
await mkdir(destination, { recursive: true });

for (const asset of assets) {
  const source = fileURLToPath(import.meta.resolve(`onnxruntime-web/${asset}`));
  await copyFile(source, `${destination}/${asset}`);
}

console.log(
  `Prepared ONNX Runtime ${installedPackage.version} assets in public/ort`,
);
