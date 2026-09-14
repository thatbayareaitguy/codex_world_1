import type { SpotifyRequestGate } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import { budgetSpotifyRequestGate, SpotifyRequestBudgetError } from "./scan";

describe("Spotify per-run request budget", () => {
  it("stops before issuing a request beyond the configured maximum", async () => {
    const acquire = vi.fn(() =>
      Promise.resolve({
        eventId: "event",
        leaseToken: "lease",
        queueLength: 0,
        queueWaitMs: 0,
        startedAt: new Date(),
      }),
    );
    const gate: SpotifyRequestGate = {
      acquire,
      complete: vi.fn(() => Promise.resolve()),
    };
    const budgeted = budgetSpotifyRequestGate(gate, 2);

    await budgeted.acquire({ endpointCategory: "artist_albums", method: "GET" });
    await budgeted.acquire({ endpointCategory: "album", method: "GET" });
    await expect(
      budgeted.acquire({ endpointCategory: "album", method: "GET" }),
    ).rejects.toBeInstanceOf(SpotifyRequestBudgetError);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe request budget values", () => {
    const gate = {
      acquire: vi.fn(),
      complete: vi.fn(),
    } as unknown as SpotifyRequestGate;
    expect(() => budgetSpotifyRequestGate(gate, 0)).toThrow("positive integer");
  });
});
