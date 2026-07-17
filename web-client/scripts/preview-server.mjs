import { preview } from "vite";

export function withTimeout(promise, timeoutMs, description, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutError = new Error(
        `${description} timed out after ${timeoutMs} ms`,
      );
      try {
        onTimeout?.();
        reject(timeoutError);
      } catch (error) {
        reject(new AggregateError([timeoutError, error], description));
      }
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function closePreview(server, timeoutMs = 3_000) {
  if (!server?.httpServer.listening) return;
  const closed = new Promise((resolve, reject) => {
    server.httpServer.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
    server.httpServer.closeIdleConnections?.();
    server.httpServer.closeAllConnections?.();
  });
  await withTimeout(closed, timeoutMs, "Vite preview shutdown", () => {
    server.httpServer.closeAllConnections?.();
  });
}

export async function startPreview(root, options = {}) {
  const starting = preview({
    root,
    base: options.base,
    build: options.build,
    logLevel: options.logLevel ?? "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      strictPort: true,
    },
  });
  const server = await withTimeout(
    starting,
    options.timeoutMs ?? 10_000,
    "Vite preview startup",
    () => {
      void starting
        .then((lateServer) => closePreview(lateServer))
        .catch(() => {});
    },
  );
  const address = server.httpServer.address();
  if (!address || typeof address !== "object") {
    await closePreview(server);
    throw new Error("Vite preview did not expose its assigned port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    server,
  };
}
