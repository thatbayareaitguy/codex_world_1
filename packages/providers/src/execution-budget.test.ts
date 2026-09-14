import { describe, expect, it, vi } from "vitest";
import {
  providerCancellableDelay,
  providerExecutionSignal,
  reserveProviderCapacityWait,
  withProviderExecutionBudget,
} from "./execution-budget";
import { SpotifyClient, SpotifyOAuthClient, type SpotifyRequestGate } from "./spotify";

describe("inherited provider execution deadline", () => {
  it("cancels nested waits and refuses requests after the same owner exits", async () => {
    const controller = new AbortController();
    const reserve = vi.fn();
    await withProviderExecutionBudget(
      { signal: controller.signal, reserveCapacityWait: reserve },
      async () => {
        reserveProviderCapacityWait(100);
        const pending = providerCancellableDelay(60_000);
        controller.abort(new Error("episode ended"));
        await expect(pending).rejects.toThrow("episode ended");
        expect(() => providerExecutionSignal()).toThrow("episode ended");
        expect(() => reserveProviderCapacityWait(200)).toThrow("episode ended");
      },
    );
    expect(reserve).toHaveBeenCalledExactlyOnceWith(100);
    expect(providerExecutionSignal()).toBeUndefined();
  });

  it.each(["api", "oauth"] as const)(
    "passes cancellation into the %s gate before any HTTP request",
    async (kind) => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>();
      const acquire = vi.fn<SpotifyRequestGate["acquire"]>(({ signal }) => {
        expect(signal).toBeDefined();
        controller.abort(new Error("fixed deadline"));
        signal!.throwIfAborted();
        throw new Error("unreachable");
      });
      const requestGate: SpotifyRequestGate = { acquire, complete: vi.fn() };
      await expect(
        withProviderExecutionBudget(
          { signal: controller.signal, reserveCapacityWait: vi.fn() },
          () =>
            kind === "api"
              ? new SpotifyClient({
                  accessToken: () => Promise.resolve("synthetic"),
                  fetcher,
                  requestGate,
                }).getCurrentUser()
              : new SpotifyOAuthClient({
                  clientId: "synthetic",
                  clientSecret: "synthetic",
                  redirectUri: "http://127.0.0.1:3000/api/auth/spotify/callback",
                  fetcher,
                  requestGate,
                }).refresh("synthetic"),
        ),
      ).rejects.toThrow("fixed deadline");
      expect(fetcher).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledOnce();
    },
  );

  it("aborts an in-flight fetch and does not retry it after cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("owner fenced")), {
            once: true,
          });
          controller.abort(new Error("owner fenced"));
        }),
    );
    await expect(
      withProviderExecutionBudget({ signal: controller.signal, reserveCapacityWait: vi.fn() }, () =>
        new SpotifyClient({
          accessToken: () => Promise.resolve("synthetic"),
          fetcher,
        }).getCurrentUser(),
      ),
    ).rejects.toThrow("owner fenced");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
