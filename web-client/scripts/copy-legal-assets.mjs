import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const localLegalAssets = [
  [new URL("../../LICENSE", import.meta.url), "EUPL-1.2.txt"],
  [
    new URL("../../third_party/licenses/Apache-2.0.txt", import.meta.url),
    "APACHE-2.0.txt",
  ],
  [
    new URL("../legal/MIT-ONNX-RUNTIME.txt", import.meta.url),
    "MIT-ONNX-RUNTIME.txt",
  ],
  [
    new URL("../legal/THIRD_PARTY_NOTICES.txt", import.meta.url),
    "THIRD_PARTY_NOTICES.txt",
  ],
  [new URL("../../ml/digits/NOTICE.md", import.meta.url), "MODEL_NOTICE.txt"],
  [new URL("../node_modules/react/LICENSE", import.meta.url), "MIT-REACT.txt"],
  [
    new URL("../node_modules/@noble/hashes/LICENSE", import.meta.url),
    "MIT-NOBLE-HASHES.txt",
  ],
];

export const remoteLegalAssets = [
  {
    name: "ONNXRUNTIME-THIRD-PARTY-NOTICES.txt",
    url: "https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/ThirdPartyNotices.txt",
    sha256: "0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2",
  },
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function validateLegalInputs() {
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  const notices = await readFile(
    new URL("../legal/THIRD_PARTY_NOTICES.txt", import.meta.url),
    "utf8",
  );
  const packages = lock.packages;
  const apacheLicense = await readFile(
    new URL("../../third_party/licenses/Apache-2.0.txt", import.meta.url),
  );
  if (
    sha256(apacheLicense) !==
    "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
  ) {
    throw new Error("tracked Apache-2.0 license does not match upstream text");
  }
  const noticeVersions = [
    ["React", packages["node_modules/react"].version],
    ["React DOM", packages["node_modules/react-dom"].version],
    ["Scheduler", packages["node_modules/scheduler"].version],
    ["ONNX Runtime Web", packages["node_modules/onnxruntime-web"].version],
    [
      "ONNX Runtime Common",
      packages["node_modules/onnxruntime-common"].version,
    ],
    ["@noble/hashes", packages["node_modules/@noble/hashes"].version],
  ];
  for (const [name, version] of noticeVersions) {
    if (!notices.includes(`${name} ${version}`)) {
      throw new Error(`${name} ${version} is missing from third-party notices`);
    }
  }

  const reactLicense = await readFile(
    new URL("../node_modules/react/LICENSE", import.meta.url),
  );
  for (const name of ["react-dom", "scheduler"]) {
    const license = await readFile(
      new URL(`../node_modules/${name}/LICENSE`, import.meta.url),
    );
    if (sha256(license) !== sha256(reactLicense)) {
      throw new Error(`${name} no longer shares React's distributed license`);
    }
  }
}

async function ensureRemoteAsset(asset, destination) {
  try {
    if (sha256(await readFile(destination)) === asset.sha256) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`failed to fetch ${asset.name}: HTTP ${response.status}`);
  }
  const contents = Buffer.from(await response.arrayBuffer());
  const actual = sha256(contents);
  if (actual !== asset.sha256) {
    throw new Error(
      `${asset.name} SHA-256 ${actual} does not match pinned ${asset.sha256}`,
    );
  }

  const temporary = `${destination}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, destination);
}

export async function prepareLegalAssets() {
  const destination = fileURLToPath(
    new URL("../public/legal/", import.meta.url),
  );
  await mkdir(destination, { recursive: true });
  await validateLegalInputs();

  for (const [source, name] of localLegalAssets) {
    await copyFile(source, `${destination}/${name}`);
  }
  for (const asset of remoteLegalAssets) {
    await ensureRemoteAsset(asset, `${destination}/${asset.name}`);
  }
  const expected = new Set([
    ...localLegalAssets.map(([, name]) => name),
    ...remoteLegalAssets.map(({ name }) => name),
  ]);
  for (const name of await readdir(destination)) {
    if (!expected.has(name))
      await rm(`${destination}/${name}`, { recursive: true });
  }
  console.log("Prepared distribution licenses and third-party notices");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await prepareLegalAssets();
}
