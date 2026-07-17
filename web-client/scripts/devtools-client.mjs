const OPEN = 1;
const CONNECTING = 0;

function websocketError(event) {
  const detail = event?.message ? `: ${event.message}` : "";
  return new Error(`CDP WebSocket error${detail}`);
}

function websocketClosed(event) {
  const code = event?.code ? ` code ${event.code}` : "";
  const reason = event?.reason ? `: ${event.reason}` : "";
  return new Error(`CDP WebSocket closed${code}${reason}`);
}

export class DevToolsClient {
  constructor(
    url,
    {
      commandTimeoutMs = 5_000,
      createSocket = (value) => new WebSocket(value),
    } = {},
  ) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.failure = null;
    this.socket = createSocket(url);
    this.socket.addEventListener("message", (event) =>
      this.handleMessage(event),
    );
    this.socket.addEventListener("error", (event) => {
      this.fail(websocketError(event));
    });
    this.socket.addEventListener("close", (event) => {
      this.fail(websocketClosed(event));
    });
  }

  async open(timeoutMs = this.commandTimeoutMs) {
    if (this.failure) throw this.failure;
    if (this.socket.readyState === OPEN) return;
    if (this.socket.readyState !== CONNECTING) {
      throw new Error("CDP WebSocket is not connectable");
    }
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", opened);
        this.socket.removeEventListener("error", failed);
        this.socket.removeEventListener("close", failed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(this.failure ?? new Error("CDP WebSocket failed to open"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`CDP WebSocket open timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.socket.addEventListener("open", opened, { once: true });
      this.socket.addEventListener("error", failed, { once: true });
      this.socket.addEventListener("close", failed, { once: true });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = this.commandTimeoutMs) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.socket.readyState !== OPEN) {
      return Promise.reject(
        new Error(`cannot send ${method}: CDP WebSocket is not open`),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timer });
      try {
        this.socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId && { sessionId }),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  close() {
    this.fail(new Error("CDP client closed"));
    if (
      this.socket.readyState === CONNECTING ||
      this.socket.readyState === OPEN
    ) {
      try {
        this.socket.close();
      } catch {
        // Pending commands were already rejected above.
      }
    }
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      this.fail(new Error(`invalid CDP message: ${error.message}`));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${message.error.message}`));
    } else {
      pending.resolve(message.result);
    }
  }

  fail(error) {
    if (!this.failure) this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
}
