import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { withTimeout } from "./preview-server.mjs";

const EXPECTED_MODEL_BYTES = 1_714_986;
const EXPECTED_MODEL_SHA256 =
  "bea69199be71c01a35f4485ad853ef6fd11608c616c452598cb3f330922db9af";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(repoRoot, "scripts", "serve-handwriting-poc.sh");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function signalProcessGroup(child, signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopLauncher(child) {
  if (!child?.pid) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    signalProcessGroup(child, "SIGKILL");
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalProcessGroup(child, "SIGTERM");
  try {
    await withTimeout(exited, 3_000, "launcher SIGTERM shutdown");
    signalProcessGroup(child, "SIGKILL");
    return;
  } catch {
    signalProcessGroup(child, "SIGKILL");
  }
  await withTimeout(exited, 3_000, "launcher SIGKILL shutdown");
}

async function waitForUrl(child, output, expectPhoneQr, timeoutMs = 45_000) {
  let cancel = () => {};
  const waiting = new Promise((resolve, reject) => {
    const inspect = (chunk) => {
      output.value += chunk.toString();
      const plainOutput = stripVTControlCharacters(output.value);
      const match = plainOutput.match(
        /http:\/\/(?:localhost|127\.0\.0\.1):(\d+)\//,
      );
      if (
        !match ||
        (expectPhoneQr &&
          (!plainOutput.includes("Scan this QR code to open http://") ||
            !output.value.includes("\u001b[97;40m")))
      )
        return;
      cleanup();
      resolve({
        origin: `http://127.0.0.1:${match[1]}`,
        port: Number(match[1]),
      });
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const exited = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `launcher exited before serving (code ${code}, signal ${signal})\n${output.value}`,
        ),
      );
    };
    const cleanup = () => {
      child.stdout.off("data", inspect);
      child.stderr.off("data", inspect);
      child.off("error", failed);
      child.off("exit", exited);
    };
    cancel = cleanup;
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", failed);
    child.once("exit", exited);
  });
  try {
    return await withTimeout(
      waiting,
      timeoutMs,
      "root launcher startup",
      cancel,
    );
  } catch (error) {
    error.message += `\nLauncher output:\n${output.value}`;
    throw error;
  }
}

async function expectServerStopped(origin) {
  try {
    await fetch(`${origin}/`, { signal: AbortSignal.timeout(750) });
  } catch {
    return;
  }
  throw new Error(`launcher server still responds after SIGTERM at ${origin}`);
}

async function exerciseLauncher(
  script,
  cwd,
  args,
  expectedOccupiedPort = null,
  expectPhoneQr = true,
) {
  const child = spawn(script, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { value: "" };
  let origin;
  try {
    const started = await waitForUrl(child, output, expectPhoneQr);
    origin = started.origin;
    if (expectPhoneQr) {
      const plainOutput = stripVTControlCharacters(output.value);
      assert(
        /Scan this QR code to open http:\/\/(?!127\.0\.0\.1|localhost)[^\s]+ on your phone:/.test(
          plainOutput,
        ),
        "launcher did not print a LAN URL for the phone QR code",
      );
      assert(
        output.value.includes("\u001b[97;40m") &&
          (output.value.includes("\u2580") || output.value.includes("\u2584")),
        "launcher did not print compact QR terminal data",
      );
    }
    if (expectedOccupiedPort !== null) {
      assert(
        started.port !== expectedOccupiedPort,
        `launcher did not fall back from occupied port ${expectedOccupiedPort}`,
      );
    }

    const index = await fetch(`${origin}/`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      index.status === 200,
      `launcher index returned HTTP ${index.status}`,
    );
    assert(
      (await index.text()).includes('<div id="root"></div>'),
      "launcher did not serve the web-client production index",
    );

    const metadataResponse = await fetch(`${origin}/models/digits-crnn.json`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      metadataResponse.status === 200,
      `launcher metadata returned HTTP ${metadataResponse.status}`,
    );
    const metadata = await metadataResponse.json();
    assert(metadata.model.bytes === EXPECTED_MODEL_BYTES, "model size changed");
    assert(
      metadata.model.sha256 === EXPECTED_MODEL_SHA256,
      "model SHA-256 changed",
    );
    const modelResponse = await fetch(`${origin}/models/digits-crnn.onnx`, {
      signal: AbortSignal.timeout(5_000),
    });
    assert(
      modelResponse.status === 200,
      `launcher model returned HTTP ${modelResponse.status}`,
    );
    const model = Buffer.from(await modelResponse.arrayBuffer());
    assert(
      model.byteLength === EXPECTED_MODEL_BYTES,
      "served model size is wrong",
    );
    assert(
      createHash("sha256").update(model).digest("hex") ===
        EXPECTED_MODEL_SHA256,
      "served model SHA-256 is wrong",
    );
  } finally {
    await stopLauncher(child);
  }
  await expectServerStopped(origin);
}

async function reservePort() {
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  assert(
    address && typeof address === "object",
    "failed to occupy a test port",
  );
  return { port: address.port, reservation };
}

async function closeReservation(reservation) {
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
}

const spaceRoot = await mkdtemp(join(tmpdir(), "ppoker launcher smoke "));
let reservation;

try {
  await exerciseLauncher(launcher, repoRoot, []);

  await mkdir(join(spaceRoot, "scripts"));
  const copiedLauncher = join(spaceRoot, "scripts", "serve-handwriting-poc.sh");
  await copyFile(launcher, copiedLauncher);
  await chmod(copiedLauncher, 0o755);
  await copyFile(join(repoRoot, "LICENSE"), join(spaceRoot, "LICENSE"));
  await mkdir(join(spaceRoot, "ml", "digits"), { recursive: true });
  await copyFile(
    join(repoRoot, "ml", "digits", "NOTICE.md"),
    join(spaceRoot, "ml", "digits", "NOTICE.md"),
  );
  await mkdir(join(spaceRoot, "third_party", "licenses"), { recursive: true });
  await copyFile(
    join(repoRoot, "third_party", "licenses", "Apache-2.0.txt"),
    join(spaceRoot, "third_party", "licenses", "Apache-2.0.txt"),
  );
  const sourceWeb = join(repoRoot, "web-client");
  const copiedWeb = join(spaceRoot, "web-client");
  const excluded = [
    "coverage",
    "dist",
    join("public", "legal"),
    join("public", "ort"),
  ];
  await cp(sourceWeb, copiedWeb, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const path = relative(sourceWeb, source);
      return !excluded.some(
        (excludedPath) =>
          path === excludedPath || path.startsWith(`${excludedPath}${sep}`),
      );
    },
  });

  const occupied = await reservePort();
  reservation = occupied.reservation;
  await exerciseLauncher(
    copiedLauncher,
    spaceRoot,
    ["--host", "127.0.0.1", "--port", String(occupied.port)],
    occupied.port,
    false,
  );
  console.log(
    "Root launcher smoke passed (repository root, path with spaces, occupied-port fallback, assets, and SIGTERM cleanup).",
  );
} finally {
  const cleanupErrors = [];
  try {
    if (reservation) await closeReservation(reservation);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await rm(spaceRoot, { force: true, recursive: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "launcher smoke cleanup failed");
  }
}
