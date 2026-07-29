import { expect, test } from "@playwright/test";

const DEMO_URL =
  process.env["SEDA_DEMO_URL"] ??
  "http://127.0.0.1:4173/examples/browser-demo/";

test("loads the microphone-first GitHub Pages demo", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(DEMO_URL);

  await expect(
    page.getByRole("heading", { name: "Your voice. Your browser." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Load Seda" })).toBeEnabled();
  await expect(page.getByText("Audio stays local")).toBeVisible();
  await expect(page.getByText("WebGPU + WASM")).toBeVisible();
  expect(await page.evaluate(() => globalThis.isSecureContext)).toBe(true);
  expect(pageErrors).toEqual([]);
});
