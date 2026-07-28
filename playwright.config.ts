import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "packages/client/browser-test",
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    permissions: ["microphone"],
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
});
