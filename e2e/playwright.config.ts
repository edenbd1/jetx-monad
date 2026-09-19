import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the live game on Monad Testnet, in a phone viewport.
 * BASE_URL defaults to a local `pnpm dev -p 3200` (with HOUSE_PRIVATE_KEY set); point it at the
 * Vercel deployment to test production.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "report", open: "never" }]],
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: process.env.BASE_URL || "http://localhost:3200",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
