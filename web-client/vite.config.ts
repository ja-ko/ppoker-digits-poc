import react from "@vitejs/plugin-react";
import { renderUnicodeCompact } from "uqr";
import { defineConfig } from "vite";
import type { Plugin } from "vite";

function phoneQrCode(): Plugin {
  return {
    name: "phone-qr-code",
    configurePreviewServer(server) {
      server.httpServer.once("listening", () => {
        setImmediate(() => {
          const networkUrl = server.resolvedUrls?.network[0];
          if (!networkUrl) {
            server.config.logger.warn(
              "No LAN URL is available for the phone QR code.",
            );
            return;
          }
          server.config.logger.info(
            `\nScan this QR code to open ${networkUrl} on your phone:\n\n\u001b[97;40m${renderUnicodeCompact(networkUrl, { border: 2 })}\u001b[0m\n`,
          );
        });
      });
    },
  };
}

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    react(),
    process.env.PPOKER_PRINT_PHONE_QR === "1" && phoneQrCode(),
  ],
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
});
