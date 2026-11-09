import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { config } from "./lib/config";

const results = config.resultsDir;

/**
 * Started by the QA console without an authenticator key: a sign-in may wait
 * for the employee to send a code in the job's chat, so a test gets more time.
 * Every other run keeps the one-minute limit.
 */
const consoleRun = Boolean(process.env.CONSOLE_JOB_URL);
const waitsForCodes = consoleRun && !process.env.QA_TOTP_SECRET;

export default defineConfig({
  testDir: "./tests",
  outputDir: path.join(results, "artifacts"),
  // One worker: the suite shares one bot account and one-time codes can only
  // be used once. ~1 minute end to end, so parallelism isn't worth the risk.
  workers: 1,
  fullyParallel: false,
  // A failure is re-run once to confirm it before it is reported as real.
  // A pass on the re-run is reported as "flaky" (visible, never hidden), not as a failure.
  retries: Number(process.env.QA_RETRIES ?? 1),
  timeout: waitsForCodes ? 15 * 60_000 : 60_000,
  expect: { timeout: 7_000 },
  forbidOnly: !!process.env.CI,
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts",
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(results, "html"), open: "never" }],
    ["json", { outputFile: path.join(results, "playwright.json") }],
    ["./reporter/plain-report.ts"],
    // Notes for the console's job chat. Only when the console started the run.
    ...(consoleRun ? ([["./reporter/console-chat.ts"]] as [string][]) : []),
  ],
  use: {
    baseURL: config.baseURL,
    // Fixed locale/timezone/viewport: same rendering on every machine and run.
    locale: "en-GB",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    // Identify bot traffic so ops can exclude it from analytics, billing and alerts.
    extraHTTPHeaders: { "X-QA-Run": config.runId },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/, use: { ...devices["Desktop Chrome"] } },
    {
      name: "user-journeys",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Chrome"], storageState: config.storageState },
    },
  ],
});
