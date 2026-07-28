import { describe, expect, it } from "vitest";
import { Seda } from "../src/client.js";
import type { WebSocketLike } from "../src/types.js";

describe("browser network addressing", () => {
  it.each([
    ["http://127.0.0.1:43123", "loopback"],
    ["http://localhost:43123", "loopback"],
    ["http://[::1]:43123", "loopback"],
    ["http://192.168.1.20:43123", "local"],
    ["https://speech.example", undefined],
  ])("labels %s as %s", async (baseUrl, expected) => {
    let requestInit: RequestInit | undefined;
    await Seda.connect({
      baseUrl,
      token: "test-token",
      fetch: async (_input, init) => {
        requestInit = init;
        return Response.json({ protocol: 1 });
      },
      webSocket: () => ({}) as WebSocketLike,
    });

    expect(
      (
        requestInit as RequestInit & {
          targetAddressSpace?: "local" | "loopback";
        }
      ).targetAddressSpace,
    ).toBe(expected);
  });
});
