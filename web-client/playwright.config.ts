import { defineConfig } from "@playwright/test";

const port = 4173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: {
    timeout: 1_000,
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.005,
      stylePath: "./e2e/screenshot.css",
    },
  },
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    actionTimeout: 1_000,
    navigationTimeout: 5_000,
    browserName: "chromium",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    colorScheme: "dark",
    contextOptions: { reducedMotion: "no-preference" },
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "chromium-behavior", testIgnore: /visual\.spec\.ts/ },
    {
      name: "webkit-ios-regression",
      testMatch: /ios-regression\.spec\.ts/,
      use: { browserName: "webkit" },
    },
    {
      name: "chromium",
      testMatch: /visual\.spec\.ts/,
      use: {
        launchOptions: { args: ["--font-render-hinting=none"] },
      },
    },
  ],
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: baseURL,
    timeout: 15_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
