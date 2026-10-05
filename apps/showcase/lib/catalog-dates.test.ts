import { describe, expect, it } from "vitest";
import { catalogAtDate, releasesThisWeek } from "./catalog-dates";
import { buildPublicCatalogSnapshot, getReleaseArtists, publicCatalog } from "./public-catalog";

describe("deployment snapshot freshness", () => {
  it("promotes past upcoming releases without a database refresh and preserves the source", () => {
    const snapshot = {
      ...publicCatalog,
      releases: [
        { ...publicCatalog.releases[0]!, releaseDate: "2026-10-02", status: "upcoming" as const },
      ],
    };
    expect(catalogAtDate(snapshot, new Date("2026-10-01T23:59:59Z")).releases[0]?.status).toBe(
      "upcoming",
    );
    expect(catalogAtDate(snapshot, new Date("2026-10-02T00:00:00Z")).releases[0]?.status).toBe(
      "released",
    );
    expect(snapshot.releases[0]?.status).toBe("upcoming");
  });
  it("does not call September discoveries new in October", () => {
    const release = {
      ...publicCatalog.releases[0]!,
      releaseDate: "2026-09-01",
      firstDiscoveredDate: "2026-09-02",
    };
    expect(releasesThisWeek([release], new Date("2026-10-04T00:00:00Z"))).toEqual([]);
    expect(
      releasesThisWeek(
        [{ ...release, firstDiscoveredDate: "2026-10-02" }],
        new Date("2026-10-04T00:00:00Z"),
      ),
    ).toHaveLength(1);
  });
  it("does not overlay deployed editorial assignments on authoritative Neon data", () => {
    const snapshot = {
      ...publicCatalog,
      artists: publicCatalog.artists.map((artist) => ({ ...artist, genreSlugs: [] })),
    };
    expect(buildPublicCatalogSnapshot(snapshot, { applyEditorial: false })).toEqual(snapshot);
  });
  it("resolves credited artists against the supplied catalog", () => {
    const artist = { ...publicCatalog.artists[0]!, name: "Fresh public artist" };
    const release = {
      ...publicCatalog.releases[0]!,
      artistCredits: [{ name: artist.name, artistSlug: artist.slug }],
    };
    expect(getReleaseArtists(release, { ...publicCatalog, artists: [artist] })).toEqual([artist]);
  });
});
