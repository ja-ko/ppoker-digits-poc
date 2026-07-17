import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withTimeout } from "./preview-server.mjs";

const benchmark = fileURLToPath(
  new URL("./browser-benchmark.mjs", import.meta.url),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function processGroupMembers(processGroup) {
  if (!Number.isInteger(processGroup)) return [];
  const entries = await readdir("/proc", { withFileTypes: true });
  const members = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
          return Number(fields[2]) === processGroup
            ? { pid: Number(entry.name), state: fields[0] }
            : null;
        } catch (error) {
          if (["EACCES", "ENOENT", "ESRCH"].includes(error.code)) return null;
          throw error;
        }
      }),
  );
  return members.filter(Boolean);
}

async function processesUsingProfile(profile) {
  if (!profile) return [];
  const entries = await readdir("/proc", { withFileTypes: true });
  const matches = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map(async (entry) => {
        try {
          const command = await readFile(`/proc/${entry.name}/cmdline`);
          return command.includes(Buffer.from(profile))
            ? Number(entry.name)
            : null;
        } catch (error) {
          if (["EACCES", "ENOENT", "ESRCH"].includes(error.code)) return null;
          throw error;
        }
      }),
  );
  return matches.filter(Boolean);
}

async function waitForEmptyProcessGroup(processGroup, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let members;
  do {
    members = await processGroupMembers(processGroup);
    if (members.length === 0) return members;
    await delay(25);
  } while (Date.now() < deadline);
  return members;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForState(path, expectedStage, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      if (!expectedStage || state.stage === expectedStage) return state;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for benchmark state ${expectedStage}`);
}

async function previewResponds(origin) {
  try {
    const response = await fetch(`${origin}/`, {
      signal: AbortSignal.timeout(750),
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

async function assertCleanExit(state) {
  assert(
    state.browserProcessGroup,
    "benchmark did not use a Chromium process group",
  );
  const members = await waitForEmptyProcessGroup(state.browserPid);
  assert(
    members.length === 0,
    `Chromium process group ${state.browserPid} survived: ${JSON.stringify(members)}`,
  );
  const profileProcesses = await processesUsingProfile(state.profile);
  assert(
    profileProcesses.length === 0,
    `Chromium profile processes survived: ${profileProcesses.join(", ")}`,
  );
  assert(
    !(await previewResponds(state.origin)),
    `preview remained reachable after benchmark exit at ${state.origin}`,
  );
  if (await pathExists(state.profile)) {
    const entries = await readdir(state.profile);
    throw new Error(
      `temporary Chromium profile survived at ${state.profile}: ${entries.join(", ")}`,
    );
  }
}

async function runCase(temporary, options) {
  const statePath = join(temporary, `${options.name}.json`);
  let child;
  let state;
  let output = "";
  try {
    const startedAt = performance.now();
    child = spawn(process.execPath, [benchmark], {
      detached: true,
      env: {
        ...process.env,
        PPOKER_BENCHMARK_FORCE_DISCONNECT: options.forceDisconnect ? "1" : "0",
        PPOKER_BENCHMARK_SIGNAL_TEST: options.signal ? "1" : "0",
        PPOKER_BENCHMARK_TEST_STATE: statePath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });

    let signalledAt;
    if (options.signal) {
      state = await waitForState(statePath, "signal-ready");
      signalledAt = performance.now();
      assert(child.kill(options.signal), `failed to send ${options.signal}`);
    }

    const result = await withTimeout(
      closed,
      10_000,
      `${options.name} benchmark`,
      () => killProcessGroup(child.pid),
    );
    const elapsedMs = performance.now() - (signalledAt ?? startedAt);
    state = await waitForState(statePath);

    if (options.signal) {
      assert(
        result.code === options.exitCode && result.signal === null,
        `${options.signal} exited with code ${result.code}, signal ${result.signal}`,
      );
      assert(
        elapsedMs < 5_000,
        `${options.signal} cleanup took ${elapsedMs.toFixed(0)} ms`,
      );
    } else {
      assert(result.code !== 0, "forced CDP disconnect exited successfully");
      assert(
        result.signal === null,
        `benchmark was killed by ${result.signal}`,
      );
      assert(
        elapsedMs < 8_000,
        `disconnect failure took ${elapsedMs.toFixed(0)} ms`,
      );
      assert(
        /CDP WebSocket (?:closed|error)/.test(output),
        `benchmark did not report the CDP disconnect:\n${output}`,
      );
    }

    // Assert before the self-test's own finally cleanup so leaks fail the test.
    try {
      await assertCleanExit(state);
    } catch (error) {
      error.message += `\nbenchmark state: ${JSON.stringify(state)}\nbenchmark output:\n${output}`;
      throw error;
    }
    console.log(
      `${options.name} cleanup passed in ${elapsedMs.toFixed(0)} ms.`,
    );
  } finally {
    killProcessGroup(child?.pid);
    if (!state) {
      try {
        state = await waitForState(statePath, null, 250);
      } catch {
        // The benchmark may have failed before creating resources.
      }
    }
    killProcessGroup(state?.browserPid);
    for (const pid of await processesUsingProfile(state?.profile)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (state?.profile) {
      await rm(state.profile, { force: true, recursive: true });
    }
  }
}

const temporary = await mkdtemp(join(tmpdir(), "ppoker-benchmark-cleanup-"));

try {
  await runCase(temporary, {
    name: "forced disconnect",
    forceDisconnect: true,
  });
  await runCase(temporary, {
    name: "SIGTERM",
    exitCode: 143,
    signal: "SIGTERM",
  });
  await runCase(temporary, {
    name: "SIGINT",
    exitCode: 130,
    signal: "SIGINT",
  });
  console.log(
    "Benchmark failure and signal cleanup self-tests passed with no process-group, preview, or profile leaks.",
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
