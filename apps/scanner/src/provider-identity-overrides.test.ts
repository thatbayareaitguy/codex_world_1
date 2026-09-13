import { describe, expect, it } from "vitest";
import type { ScannerOptions } from "./args";
import { providerIdentityOverrides } from "./provider-identity-overrides";

describe("provider identity overrides", () => {
  const base: ScannerOptions = { dryRun: false, full: false };

  it("returns the complete snapshotted provider identity cohort", () => {
    const overrides = providerIdentityOverrides(
      {
        ...base,
        artistIds: ["artist-1", "artist-2"],
        providerArtistIdentities: [
          { artistId: "artist-1", providerArtistId: "provider-1" },
          { artistId: "artist-2", providerArtistId: "provider-2" },
        ],
      },
      ["artist-1", "artist-2"],
    );

    expect([...overrides]).toEqual([
      ["artist-1", "provider-1"],
      ["artist-2", "provider-2"],
    ]);
  });

  it("rejects incomplete, duplicate, and out-of-cohort overrides", () => {
    expect(() =>
      providerIdentityOverrides(
        {
          ...base,
          providerArtistIdentities: [{ artistId: "artist-1", providerArtistId: "provider-1" }],
        },
        [],
      ),
    ).toThrow("explicit internal artist cohort");
    expect(() =>
      providerIdentityOverrides(
        {
          ...base,
          providerArtistIdentities: [{ artistId: "artist-1", providerArtistId: "provider-1" }],
        },
        ["artist-1", "artist-2"],
      ),
    ).toThrow("complete requested artist cohort");
    expect(() =>
      providerIdentityOverrides(
        {
          ...base,
          providerArtistIdentities: [
            { artistId: "artist-1", providerArtistId: "provider-1" },
            { artistId: "artist-1", providerArtistId: "provider-2" },
          ],
        },
        ["artist-1"],
      ),
    ).toThrow("more than once");
    expect(() =>
      providerIdentityOverrides(
        {
          ...base,
          providerArtistIdentities: [{ artistId: "artist-2", providerArtistId: "provider-2" }],
        },
        ["artist-1"],
      ),
    ).toThrow("outside the requested artist cohort");
  });
});
