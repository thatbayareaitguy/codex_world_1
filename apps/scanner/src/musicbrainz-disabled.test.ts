import { loadProviderConfiguration } from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import { musicBrainzDisabledMessage, runScan, runScanUnlocked } from "./scan";

describe("disabled MusicBrainz scanner boundary", () => {
  it("rejects an explicit scan before provider or database work", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("MUSICBRAINZ_ENABLED", "false");

    await expect(runScan({ dryRun: true, full: false, provider: "musicbrainz" })).rejects.toThrow(
      musicBrainzDisabledMessage,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("keeps disabled MusicBrainz out of a normal provider selection", async () => {
    const configuration = loadProviderConfiguration({ MUSICBRAINZ_ENABLED: "false" });
    const summary = await runScanUnlocked({ dryRun: true, full: false }, configuration);

    expect(summary).toMatchObject({ discovered: 5, dryRun: true });
  });
});
