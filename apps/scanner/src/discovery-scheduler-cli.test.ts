import type { createDatabase } from "@radar/db";
import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  discoverySchedulerRoute,
  parseDiscoverySchedulerCommand,
  runReadyAutomaticPlaylistExport,
} from "./discovery-scheduler-cli";

describe("discovery scheduler CLI", () => {
  it("parses only the supported commands", () => {
    expect(parseDiscoverySchedulerCommand(["status"])).toBe("status");
    expect(parseDiscoverySchedulerCommand(["--", "tick"])).toBe("tick");
    expect(() => parseDiscoverySchedulerCommand(["run"])).toThrow("Usage:");
  });

  it.each(["ready", "exporting", "partial", "failed"])(
    "routes a %s playlist checkpoint to the automatic exporter",
    (playlistInboxStatus) => {
      expect(discoverySchedulerRoute({ phase: "playlist_inbox", playlistInboxStatus })).toBe(
        "playlist_export",
      );
    },
  );

  it.each(["apple_priority", "apple_catchup_priority", "cooldown_wait"])(
    "routes %s through bounded Spotify priority handling",
    (phase) => {
      expect(discoverySchedulerRoute({ phase, playlistInboxStatus: "pending" })).toBe(
        "spotify_priority",
      );
    },
  );

  it("leaves Apple claims and broad work on the normal route", () => {
    expect(
      discoverySchedulerRoute({ phase: "broad_spotify", playlistInboxStatus: "completed" }),
    ).toBe("apple_or_spotify");
  });

  it.each(["Thursday full scan", "Friday catch-up"])(
    "continues %s into automatic export without an interactive command",
    async () => {
      const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
      const db = {} as ReturnType<typeof createDatabase>["db"];

      await expect(
        runReadyAutomaticPlaylistExport(db, loadProviderConfiguration({}), {
          getStatus: () =>
            Promise.resolve({ phase: "playlist_inbox", playlistInbox: { status: "ready" } }),
          runExport,
        }),
      ).resolves.toEqual({ reason: "completed" });

      expect(runExport).toHaveBeenCalledOnce();
    },
  );

  it("does not bypass unresolved Apple-priority work", async () => {
    const runExport = vi.fn(() => Promise.resolve({ reason: "completed" as const }));
    const db = {} as ReturnType<typeof createDatabase>["db"];

    await expect(
      runReadyAutomaticPlaylistExport(db, loadProviderConfiguration({}), {
        getStatus: () =>
          Promise.resolve({ phase: "apple_priority", playlistInbox: { status: "pending" } }),
        runExport,
      }),
    ).resolves.toBeNull();
    expect(runExport).not.toHaveBeenCalled();
  });
});
