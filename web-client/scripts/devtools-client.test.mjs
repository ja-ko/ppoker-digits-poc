import { describe, expect, it, vi } from "vitest";

import { DevToolsClient } from "./devtools-client.mjs";

class FakeSocket extends EventTarget {
  readyState = 1;
  sent = [];

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.disconnect();
  }

  disconnect() {
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, {
      code: { value: 1006 },
      reason: { value: "test disconnect" },
    });
    this.dispatchEvent(event);
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }
}

describe("DevToolsClient", () => {
  it("rejects every pending command when the socket closes", async () => {
    const socket = new FakeSocket();
    const client = new DevToolsClient("ws://test", {
      createSocket: () => socket,
    });
    await client.open();
    const first = client.send("Runtime.evaluate");
    const second = client.send("Page.navigate");

    socket.disconnect();

    await expect(first).rejects.toThrow("CDP WebSocket closed code 1006");
    await expect(second).rejects.toThrow("CDP WebSocket closed code 1006");
  });

  it("bounds commands that receive no response", async () => {
    vi.useFakeTimers();
    try {
      const client = new DevToolsClient("ws://test", {
        commandTimeoutMs: 25,
        createSocket: () => new FakeSocket(),
      });
      await client.open();
      const command = client.send("Browser.getVersion");
      const rejected = expect(command).rejects.toThrow(
        "Browser.getVersion timed out after 25 ms",
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects pending commands when the socket errors", async () => {
    const socket = new FakeSocket();
    const client = new DevToolsClient("ws://test", {
      createSocket: () => socket,
    });
    await client.open();
    const command = client.send("Runtime.evaluate");

    socket.fail();

    await expect(command).rejects.toThrow("CDP WebSocket error");
  });
});
