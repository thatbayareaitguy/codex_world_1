import { describe, expect, it } from "vitest";
import {
  buildShowcasePublicCatalog,
  mapProviderGenresToShowcase,
  showcasePublicCatalogSchema,
  type ShowcasePublicationSource,
} from "./showcase-publication";

const sourceArtists = [
  {
    appleMusicUrl: "https://music.apple.com/us/artist/real-artist/101",
    appleProviderArtistId: "apple-artist-101",
    labelAssociations: ["Reliable Label"],
    name: "Real Artist",
    providerGenres: ["Dance", "Dubstep", "Hip-Hop/Rap"],
    spotifyUrl: "https://open.spotify.com/artist/spotify-artist-101",
  },
  {
    appleMusicUrl: "https://music.apple.com/us/artist/collaborator/102",
    appleProviderArtistId: "apple-artist-102",
    labelAssociations: [],
    name: "Confirmed Collaborator",
    providerGenres: ["House", "Electronic"],
  },
] as const;

const sourceRelease = {
  appleMusicUrl: "https://music.apple.com/us/album/real-release/1001",
  appleProviderReleaseId: "apple-release-1001",
  artistCredits: [
    { appleProviderArtistId: "apple-artist-101", name: "Real Artist" },
    { appleProviderArtistId: "apple-artist-102", name: "Confirmed Collaborator" },
    { name: "Guest Vocalist" },
  ],
  firstDiscoveredAt: new Date("2026-08-20T15:00:00Z"),
  label: "Reliable Label",
  primaryAppleArtistId: "apple-artist-101",
  releaseDate: "2026-08-25",
  releaseType: "ep",
  spotifyUrl: "https://open.spotify.com/album/spotify-release-1001",
  title: "Real Release",
  tracks: [
    { discNumber: 1, position: 1, title: "First Track" },
    { discNumber: 1, position: 2, title: "Second Track" },
  ],
} as const;

const source: ShowcasePublicationSource = {
  artists: sourceArtists,
  invalidActiveArtistCount: 0,
  invalidAppleReleaseCount: 0,
  releases: [sourceRelease],
  unresolvedCollaboratorCount: 0,
};

describe("Showcase public catalog publication", () => {
  it("publishes strict public artists, controlled genres, and linked multi-artist credits", () => {
    const result = buildShowcasePublicCatalog(source, new Date("2026-08-27T12:00:00Z"));

    expect(result).toMatchObject({
      artistCount: 2,
      artistsWithGenresCount: 2,
      invalidActiveArtistCount: 0,
      invalidAppleReleaseCount: 0,
      multiCreditReleaseCount: 1,
      releaseCount: 1,
      withSpotifyCount: 1,
      withoutSpotifyCount: 0,
    });
    expect(result.catalog.contractVersion).toBe("showcase-public-v2");
    expect(result.catalog.genres).toHaveLength(17);
    expect(result.catalog.artists[0]).toMatchObject({
      name: "Confirmed Collaborator",
      genreSlugs: ["electronic", "house"],
      links: { appleMusic: "https://music.apple.com/us/artist/collaborator/102" },
    });
    expect(result.catalog.artists[1]).toMatchObject({
      name: "Real Artist",
      genreSlugs: ["dance", "dubstep"],
      labelAssociations: ["Reliable Label"],
      links: {
        appleMusic: "https://music.apple.com/us/artist/real-artist/101",
        spotify: "https://open.spotify.com/artist/spotify-artist-101",
      },
    });
    const publishedRelease = result.catalog.releases[0];
    expect(publishedRelease?.artistCredits.map((credit) => credit.name)).toEqual([
      "Real Artist",
      "Confirmed Collaborator",
      "Guest Vocalist",
    ]);
    expect(publishedRelease?.artistCredits[0]?.artistSlug).toMatch(/^real-artist-/);
    expect(publishedRelease?.artistCredits[1]?.artistSlug).toMatch(/^confirmed-collaborator-/);
    expect(publishedRelease).toMatchObject({
      firstDiscoveredDate: "2026-08-20",
      genreSlugs: ["dance", "dubstep", "electronic", "house"],
      label: "Reliable Label",
      links: {
        appleMusic: "https://music.apple.com/us/album/real-release/1001",
        spotify: "https://open.spotify.com/album/spotify-release-1001",
      },
      releaseDate: "2026-08-25",
      status: "released",
      title: "Real Release",
      type: "EP",
    });
    expect(result.catalog.artists[0]?.publicId).toMatch(/^artist_[a-f0-9]{20}$/);
    expect(result.catalog.releases[0]?.publicId).toMatch(/^release_[a-f0-9]{20}$/);
    expect(showcasePublicCatalogSchema.parse(result.catalog)).toEqual(result.catalog);
  });

  it("keeps Apple-only releases, trackless records, and release genre overrides", () => {
    const { spotifyUrl: omittedSpotifyUrl, ...appleOnlyRelease } = sourceRelease;
    void omittedSpotifyUrl;
    const result = buildShowcasePublicCatalog(
      {
        ...source,
        releases: [
          {
            ...appleOnlyRelease,
            appleProviderReleaseId: "apple-release-1002",
            genreOverrideSlugs: ["ambient"],
            releaseDate: "2026-09-01",
            tracks: [],
          },
        ],
      },
      new Date("2026-08-27T12:00:00Z"),
    );

    expect(result.catalog.releases[0]).toMatchObject({
      genreSlugs: ["ambient"],
      status: "upcoming",
      tracks: [],
    });
    expect(result.catalog.releases[0]?.links).toEqual({
      appleMusic: "https://music.apple.com/us/album/real-release/1001",
    });
    expect(result).toMatchObject({ releaseCount: 1, withSpotifyCount: 0, withoutSpotifyCount: 1 });
  });

  it("omits untrusted URLs and drops records without valid Apple release or artist links", () => {
    const result = buildShowcasePublicCatalog(
      {
        ...source,
        artists: [
          { ...sourceArtists[0], spotifyUrl: "https://example.com/not-spotify" },
          { ...sourceArtists[1], appleMusicUrl: "https://example.com/not-apple" },
        ],
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
      artistCount: 1,
      invalidActiveArtistCount: 1,
      invalidAppleReleaseCount: 1,
      releaseCount: 1,
      withSpotifyCount: 0,
      withoutSpotifyCount: 1,
    });
  });

  it("maps only the controlled Showcase taxonomy and ignores unrelated provider genres", () => {
    expect(
      mapProviderGenresToShowcase([
        "Dance",
        "Jungle/Drum'n'bass",
        "IDM/Experimental",
        "Hip-Hop/Rap",
        "Dance",
      ]),
    ).toEqual(["dance", "drum-and-bass", "experimental"]);
  });

  it("copies only allowlisted public fields from scanner source rows", () => {
    const sourceWithPrivateFields = {
      ...source,
      artists: source.artists.map((artist) => ({
        ...artist,
        databaseId: "private-artist-database-id",
        identityEvidence: ["private-identity-evidence"],
      })),
      releases: source.releases.map((release) => ({
        ...release,
        databaseId: "private-release-database-id",
        providerErrors: ["private-provider-error"],
        rawPayload: { authorization: "private-token" },
        reviewInternals: { reasons: ["private-reason"] },
        schedulerState: "private-scheduler-state",
      })),
    } satisfies ShowcasePublicationSource;
    const result = buildShowcasePublicCatalog(sourceWithPrivateFields);
    const serialized = JSON.stringify(result.catalog);

    expect(serialized).not.toContain("private-");
    expect(Object.keys(result.catalog).sort()).toEqual(
      ["artists", "contractVersion", "generatedAt", "genres", "releases"].sort(),
    );
    const artistWithLabel = result.catalog.artists.find(
      (artist) => artist.labelAssociations !== undefined,
    );
    expect(Object.keys(artistWithLabel ?? {}).sort()).toEqual(
      [
        "artworkTone",
        "genreSlugs",
        "labelAssociations",
        "links",
        "name",
        "publicId",
        "slug",
      ].sort(),
    );
    expect(Object.keys(result.catalog.releases[0] ?? {}).sort()).toEqual(
      [
        "artistCredits",
        "artworkTone",
        "firstDiscoveredDate",
        "genreSlugs",
        "label",
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
