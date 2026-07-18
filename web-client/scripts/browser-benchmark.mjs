import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DevToolsClient } from "./devtools-client.mjs";
import { closePreview, startPreview, withTimeout } from "./preview-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const browserCommand = process.env.CHROME_BIN ?? "chromium";
const browserProcessGroup = process.platform !== "win32";
const forceDisconnect = process.env.PPOKER_BENCHMARK_FORCE_DISCONNECT === "1";
const signalTest = process.env.PPOKER_BENCHMARK_SIGNAL_TEST === "1";
const testStatePath = process.env.PPOKER_BENCHMARK_TEST_STATE;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signalBrowser(browser, signal) {
  if (!browser?.pid) return;
  try {
    if (browserProcessGroup) process.kill(-browser.pid, signal);
    else if (browser.exitCode === null && browser.signalCode === null) {
      browser.kill(signal);
    }
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function browserProcessGroupExists(browser) {
  if (!browserProcessGroup || !browser?.pid) return false;
  try {
    process.kill(-browser.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForBrowserProcessGroup(browser, timeoutMs = 3_000) {
  if (!browserProcessGroup) return;
  const deadline = Date.now() + timeoutMs;
  while (browserProcessGroupExists(browser)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Chromium process group ${browser.pid} survived cleanup for ${timeoutMs} ms`,
      );
    }
    await delay(25);
  }
}

async function waitForDebugger(browser, timeoutMs = 10_000) {
  let cancel = () => {};
  const waiting = new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      browser.stderr?.off("data", receivedData);
      browser.off("error", failed);
      browser.off("exit", exited);
    };
    cancel = cleanup;
    const receivedData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      cleanup();
      resolve(match[1]);
    };
    const failed = (error) => {
      cleanup();
      reject(error);
    };
    const exited = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `browser exited before CDP startup (code ${code}, signal ${signal})`,
        ),
      );
    };
    browser.stderr?.on("data", receivedData);
    browser.once("error", failed);
    browser.once("exit", exited);
  });
  return withTimeout(waiting, timeoutMs, "Chromium CDP startup", cancel);
}

async function stopBrowser(browser) {
  if (!browser?.pid) return;
  if (browser.exitCode !== null || browser.signalCode !== null) {
    signalBrowser(browser, "SIGKILL");
    await waitForBrowserProcessGroup(browser);
    return;
  }
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  signalBrowser(browser, "SIGTERM");
  try {
    await withTimeout(exited, 3_000, "Chromium SIGTERM shutdown");
    signalBrowser(browser, "SIGKILL");
    await waitForBrowserProcessGroup(browser);
    return;
  } catch {
    signalBrowser(browser, "SIGKILL");
  }
  await withTimeout(exited, 3_000, "Chromium SIGKILL shutdown");
  await waitForBrowserProcessGroup(browser);
}

async function removeProfile(path, timeoutMs = 3_000, quietMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await rm(path, { force: true, recursive: true });
    } catch (error) {
      if (
        !["EBUSY", "ENOTEMPTY", "EPERM"].includes(error.code) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
    }
    await delay(quietMs);
    try {
      await access(path);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Chromium profile ${path} reappeared during cleanup`);
    }
  }
}

let profile;
let server;
let browser;
let client;
let previewStarting;
let cleanupPromise;
let shutdownSignal;
let testOrigin;
let forcedDisconnectAt;
let signalHandlersInstalled = false;

function writeTestState(stage, origin, cleanupError) {
  if (!testStatePath) return;
  if (origin) testOrigin = origin;
  writeFileSync(
    testStatePath,
    JSON.stringify({
      browserPid: browser?.pid,
      browserProcessGroup,
      origin: testOrigin,
      profile,
      stage,
      ...(forcedDisconnectAt && { forcedDisconnectAt }),
      ...(cleanupError && { cleanupError }),
    }),
  );
}

function cleanupResources() {
  cleanupPromise ??= (async () => {
    const cleanupErrors = [];
    if (client) {
      try {
        await client.send("Browser.close", {}, undefined, 1_000);
      } catch {
        // A closed or failed browser falls through to process-group cleanup.
      }
      client.close();
    }

    const starting = previewStarting;
    if (starting && !server) {
      try {
        server = (await starting).server;
      } catch {
        // Startup failures have no preview server to close.
      }
    }

    const cleanupResults = await Promise.allSettled([
      stopBrowser(browser),
      server ? closePreview(server) : Promise.resolve(),
    ]);
    cleanupErrors.push(
      ...cleanupResults
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    );
    try {
      if (profile) {
        await removeProfile(profile);
        writeTestState("cleanup-complete");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "browser benchmark cleanup failed",
      );
    }
  })();
  return cleanupPromise;
}

const signalHandlers = new Map(
  [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ].map(([signal, exitCode]) => [
    signal,
    () => {
      if (shutdownSignal) return;
      shutdownSignal = signal;
      const keepAlive = setInterval(() => {}, 1_000);
      void (async () => {
        try {
          writeTestState("signal-received");
        } catch {
          // Test diagnostics must not prevent production cleanup.
        }
        try {
          await cleanupResources();
          clearInterval(keepAlive);
          process.exit(exitCode);
        } catch (error) {
          try {
            writeTestState(
              "cleanup-error",
              undefined,
              error instanceof Error ? error.stack : String(error),
            );
          } catch {
            // Preserve the conventional signal exit even if diagnostics fail.
          }
          console.error(error);
          clearInterval(keepAlive);
          process.exit(exitCode);
        }
      })();
    },
  ]),
);

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
}

try {
  const sigtermListenersBeforePreview = new Set(process.listeners("SIGTERM"));
  previewStarting = startPreview(root);
  const started = await previewStarting;
  // Vite preview installs a SIGTERM listener that exits before our full cleanup.
  for (const listener of process.listeners("SIGTERM")) {
    if (!sigtermListenersBeforePreview.has(listener)) {
      process.off("SIGTERM", listener);
    }
  }
  server = started.server;
  previewStarting = null;
  profile = mkdtempSync(join(tmpdir(), "ppoker-poc-chromium-"));
  for (const [signal, handler] of signalHandlers) {
    process.on(signal, handler);
  }
  signalHandlersInstalled = true;
  const pageUrl = `${started.origin}/?diagnostics=1`;
  browser = spawn(
    browserCommand,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=390,844",
      "about:blank",
    ],
    {
      detached: browserProcessGroup,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  writeTestState("browser-started", started.origin);

  const debuggerUrl = await waitForDebugger(browser);
  client = new DevToolsClient(debuggerUrl);
  await client.open();
  const browserVersion = await client.send("Browser.getVersion");
  const { targetId } = await client.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Page.enable", {}, sessionId);
  if (signalTest) {
    writeTestState("signal-ready", started.origin);
    await client.send(
      "Runtime.evaluate",
      { expression: "new Promise(() => {})", awaitPromise: true },
      sessionId,
      60_000,
    );
    throw new Error("signal test completed without receiving a signal");
  }
  if (forceDisconnect) {
    const pending = client.send(
      "Runtime.evaluate",
      { expression: "new Promise(() => {})", awaitPromise: true },
      sessionId,
    );
    forcedDisconnectAt = Date.now();
    writeTestState("disconnect-started", started.origin);
    signalBrowser(browser, "SIGKILL");
    await pending;
    throw new Error("forced CDP disconnect unexpectedly completed its command");
  }
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 390, height: 844, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  await client.send("Page.navigate", { url: pageUrl }, sessionId);

  async function evaluate(expression) {
    let response;
    try {
      response = await client.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
    } catch (error) {
      throw new Error(
        `${error.message}; expression: ${expression.slice(0, 120)}`,
      );
    }
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text,
      );
    }
    return response.result.value;
  }

  async function waitFor(expression, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(25);
    }
    throw new Error(`timed out waiting for ${description}`);
  }

  await waitFor(
    'document.readyState === "complete" && document.querySelector("main")',
    10_000,
    "page load",
  );
  await waitFor(
    'document.querySelector("main")?.dataset.recognizerState === "ready"',
    20_000,
    "recognizer readiness",
  );
  const cold = await evaluate(`(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoadedMs: navigation.domContentLoadedEventEnd,
      pageLoadMs: navigation.loadEventEnd,
      recognizerReadyObservedMs: performance.now(),
    };
  })()`);

  const surface = await evaluate(`(() => {
    const rect = document.querySelector(".ink-surface").getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`);
  const x = surface.left + surface.width * 0.28;
  const startY = surface.top + surface.height * 0.38;
  const endY = surface.top + surface.height * 0.66;
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x, y: startY },
    sessionId,
  );
  await client.send(
    "Input.dispatchMouseEvent",
    {
      type: "mousePressed",
      x,
      y: startY,
      button: "left",
      buttons: 1,
      clickCount: 1,
    },
    sessionId,
  );
  for (let step = 1; step <= 12; step += 1) {
    await client.send(
      "Input.dispatchMouseEvent",
      {
        type: "mouseMoved",
        x,
        y: startY + ((endY - startY) * step) / 12,
        button: "left",
        buttons: 1,
      },
      sessionId,
    );
  }
  await client.send(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x, y: endY, button: "left", buttons: 0 },
    sessionId,
  );

  await waitFor(
    `(() => {
      const button = document.querySelector(".diagnostics-benchmark button");
      return button && !button.disabled && button.textContent.includes("Run benchmark");
    })()`,
    10_000,
    "a benchmarkable recognition raster",
  );
  await evaluate(
    'document.querySelector(".diagnostics-benchmark button").click()',
  );
  await waitFor(
    'document.querySelector(".diagnostics-benchmark p")?.textContent.includes("Model median/p95")',
    60_000,
    "the 10-warmup, 100-run benchmark",
  );
  const summaryText = await evaluate(
    'document.querySelector(".diagnostics-benchmark p").textContent',
  );
  const match = summaryText.match(
    /Model median\/p95 ([\d.]+)\/([\d.]+) ms; roundtrip median\/p95 ([\d.]+)\/([\d.]+) ms/,
  );
  assert(match, `could not parse benchmark result: ${summaryText}`);

  const pageEnvironment = await evaluate(`({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGiB: navigator.deviceMemory ?? null,
    crossOriginIsolated: globalThis.crossOriginIsolated,
    resources: performance.getEntriesByType("resource")
      .filter((entry) => /digits-crnn|ort-wasm/.test(entry.name))
      .map((entry) => ({ name: new URL(entry.name).pathname, durationMs: entry.duration }))
  })`);

  console.log(
    JSON.stringify(
      {
        measuredAtUtc: new Date().toISOString(),
        application: "production Vite build on local HTTP",
        browser: {
          product: browserVersion.product,
          revision: browserVersion.revision,
          protocolVersion: browserVersion.protocolVersion,
          ...pageEnvironment,
        },
        cold,
        benchmark: {
          warmups: 10,
          runs: 100,
          modelMs: { median: Number(match[1]), p95: Number(match[2]) },
          roundTripMs: { median: Number(match[3]), p95: Number(match[4]) },
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (!shutdownSignal) throw error;
} finally {
  try {
    await cleanupResources();
  } finally {
    if (!shutdownSignal && signalHandlersInstalled) removeSignalHandlers();
  }
}
