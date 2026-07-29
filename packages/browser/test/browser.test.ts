import { describe, expect, it } from "vitest";
import { SedaBrowser } from "../src/browser.js";

describe("SedaBrowser options", () => {
  it("rejects unknown models before creating a worker", async () => {
    await expect(
      SedaBrowser.prepare({ modelId: "surprise" as never }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "unknown browser model ID: surprise",
    });
  });

  it("rejects unknown devices before creating a worker", async () => {
    await expect(
      SedaBrowser.prepare({ device: "cuda" as never }),
    ).rejects.toMatchObject({
      code: "invalid_request",
      message: "unknown browser device: cuda",
    });
  });
});
