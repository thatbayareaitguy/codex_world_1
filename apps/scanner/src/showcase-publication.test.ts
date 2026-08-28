import { describe, expect, it } from "vitest";
import {
  buildShowcasePublicCatalog,
  showcasePublicCatalogSchema,
  type ShowcasePublicationSource,
} from "./showcase-publication";

const sourceRelease = {
  appleMusicUrl: "https://music.apple.com/us/album/real-release/1001",
  appleProviderReleaseId: "apple-release-1001",
  artistName: "Real Artist",
  firstDiscoveredAt: new Date("2026-08-20T15:00:00Z"),
  releaseDate: "2026-08-25",
  releaseType: "ep",
  spotifyUrl: "https://open.spotify.com/album/spotify-release-1001",
  title: "Real Release",
  tracks: [
    { discNumber: 1, position: 1, title: "First Track" },
    { discNumber: 1, position: 2, title: "Second Track" },
  ],
};

describe("Showcase public catalog publication", () => {
  it("publishes a deterministic, strict public record with confirmed outbound links", () => {
    const result = buildShowcasePublicCatalog(
      { invalidAppleReleaseCount: 0, releases: [sourceRelease] },
      new Date("2026-08-27T12:00:00Z"),
    );

    expect(result).toMatchObject({
      invalidAppleReleaseCount: 0,
      releaseCount: 1,
      withSpotifyCount: 1,
      withoutSpotifyCount: 0,
    });
    expect(result.catalog.releases[0]).toMatchObject({
      artistName: "Real Artist",
      firstDiscoveredDate: "2026-08-20",
      links: {
        appleMusic: "https://music.apple.com/us/album/real-release/1001",
        spotify: "https://open.spotify.com/album/spotify-release-1001",
      },
      releaseDate: "2026-08-25",
      status: "released",
      title: "Real Release",
      type: "EP",
    });
    expect(result.catalog.releases[0]?.publicId).toMatch(/^release_[a-f0-9]{20}$/);
    expect(result.catalog.releases[0]?.slug).toMatch(/^real-artist-real-release-[a-f0-9]{8}$/);
    expect(showcasePublicCatalogSchema.parse(result.catalog)).toEqual(result.catalog);
  });

  it("keeps Apple-only releases and marks future dates as upcoming", () => {
    const { spotifyUrl: omittedSpotifyUrl, ...appleOnlySource } = sourceRelease;
    void omittedSpotifyUrl;
    const result = buildShowcasePublicCatalog(
      {
        invalidAppleReleaseCount: 0,
        releases: [
          {
            ...appleOnlySource,
            appleProviderReleaseId: "apple-release-1002",
            releaseDate: "2026-09-01",
          },
        ],
      },
      new Date("2026-08-27T12:00:00Z"),
    );

    expect(result.catalog.releases[0]?.status).toBe("upcoming");
    expect(result.catalog.releases[0]?.links).toEqual({
      appleMusic: "https://music.apple.com/us/album/real-release/1001",
    });
    expect(result).toMatchObject({ releaseCount: 1, withSpotifyCount: 0, withoutSpotifyCount: 1 });
  });

  it("omits untrusted Spotify links and drops records without a valid Apple release URL", () => {
    const result = buildShowcasePublicCatalog(
      {
        invalidAppleReleaseCount: 0,
        releases: [
          { ...sourceRelease, spotifyUrl: "https://example.com/album/not-spotify" },
          {
            ...sourceRelease,
            appleMusicUrl: "https://example.com/not-apple",
            appleProviderReleaseId: "invalid-apple-release",
          },
        ],
      },
      new Date("2026-08-27T12:00:00Z"),
    );

    expect(result).toMatchObject({
      invalidAppleReleaseCount: 1,
      releaseCount: 1,
      withSpotifyCount: 0,
      withoutSpotifyCount: 1,
    });
  });

  it("copies only allowlisted public fields from scanner source rows", () => {
    const sourceReleaseWithPrivateFields = {
      ...sourceRelease,
      databaseId: "bb71d508-9ea5-4af3-9a19-5dd6bbc9fdd2",
      providerErrors: ["private-provider-error"],
      rawPayload: { authorization: "private-token" },
      reviewInternals: { reasons: ["private-reason"] },
      schedulerState: "private-scheduler-state",
    };
    const sourceWithPrivateFields: ShowcasePublicationSource = {
      invalidAppleReleaseCount: 0,
      releases: [sourceReleaseWithPrivateFields],
    };
    const result = buildShowcasePublicCatalog(sourceWithPrivateFields);
    const serialized = JSON.stringify(result.catalog);

    expect(serialized).not.toContain("bb71d508");
    expect(serialized).not.toContain("private-");
    expect(Object.keys(result.catalog.releases[0] ?? {}).sort()).toEqual(
      [
        "artistName",
        "artworkTone",
        "firstDiscoveredDate",
        "genres",
        "links",
        "publicId",
        "releaseDate",
        "slug",
        "status",
        "title",
        "tracks",
        "type",
      ].sort(),
    );
  });
});
