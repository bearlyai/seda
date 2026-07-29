import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "packages",
  testMatch: "**/browser-test/**/*.spec.ts",
  webServer: process.env["SEDA_DEMO_URL"]
    ? undefined
    : {
        command: "pnpm exec vite --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173/examples/browser-demo/",
        reuseExistingServer: !process.env["CI"],
      },
  fullyParallel: false,
  forbidOnly: Boolean(process.env["CI"]),
  retries: process.env["CI"] ? 1 : 0,
  workers: 1,
  reporter: process.env["CI"] ? "github" : "list",
  timeout: 30_000,
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
          ],
        },
      },
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
      },
    },
  ],
});
