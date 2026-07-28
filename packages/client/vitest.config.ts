import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "browser-test/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
