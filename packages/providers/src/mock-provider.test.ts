import { describe, expect, it } from "vitest";
import { MockProvider } from "./mock-provider";

describe("MockProvider", () => {
  it("rejects malformed fixtures at the provider boundary", async () => {
    const provider = new MockProvider({ fixtureVersion: 1, candidates: [{ title: "missing" }] });
    await expect(provider.scan({ filter: {} })).rejects.toThrow();
  });
});
