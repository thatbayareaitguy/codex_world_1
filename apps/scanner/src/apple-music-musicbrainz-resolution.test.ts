import type { AppleMusicAlbum, AppleMusicArtist, MusicBrainzReleaseGroup } from "@radar/providers";
import { describe, expect, it } from "vitest";
import { evaluateMusicBrainzAppleCandidates } from "./apple-music-musicbrainz-resolution";

const mbid = "11111111-1111-4111-8111-111111111111";

describe("independent MusicBrainz to Apple identity evaluation", () => {
  it("confirms one exact primary profile with two consistent release matches", () => {
    const result = evaluateMusicBrainzAppleCandidates(
      mbid,
      [group("Signal"), group("Night Run")],
      [
        {
          albums: [album("10", "Signal"), album("10", "Night Run")],
          artist: artist("10", "Example Artist"),
        },
      ],
    );
    expect(result.confirmedAppleArtistId).toBe("10");
  });

  it("rejects name-only, featured-only, and split-profile evidence", () => {
    const nameOnly = evaluateMusicBrainzAppleCandidates(
      mbid,
      [group("Signal")],
      [{ albums: [], artist: artist("10", "Example Artist") }],
    );
    expect(nameOnly.confirmedAppleArtistId).toBeNull();

    const featuredOnly = evaluateMusicBrainzAppleCandidates(
      mbid,
      [group("Signal"), group("Night Run")],
      [
        {
          albums: [album("99", "Signal"), album("99", "Night Run")],
          artist: artist("10", "Example Artist"),
        },
      ],
    );
    expect(featuredOnly.confirmedAppleArtistId).toBeNull();

    const split = evaluateMusicBrainzAppleCandidates(
      mbid,
      [group("Signal"), group("Night Run")],
      [
        {
          albums: [album("10", "Signal"), album("10", "Night Run")],
          artist: artist("10", "Example Artist"),
        },
        {
          albums: [album("20", "Signal"), album("20", "Night Run")],
          artist: artist("20", "Example Artist"),
        },
      ],
    );
    expect(split.confirmedAppleArtistId).toBeNull();
    expect(split.reason).toContain("Multiple Apple profiles");
  });
});

function artist(artistId: string, name: string): AppleMusicArtist {
  return { artistId, genreNames: [], name, sourceStorefront: "us" };
}

function album(artistId: string, title: string): AppleMusicAlbum {
  return {
    albumId: `${artistId}-${title}`,
    artistIds: [artistId],
    artistName: "Example Artist",
    genreNames: [],
    paginationPath: "/test",
    pageNumber: 1,
    releaseDate: "2025-01-01",
    sourceStorefront: "us",
    sourceView: "album",
    title,
  };
}

function group(title: string): MusicBrainzReleaseGroup {
  return {
    "artist-credit": [{ artist: { id: mbid, name: "Example Artist" }, name: "Example Artist" }],
    "first-release-date": "2025-01-01",
    "primary-type": "Album",
    "secondary-types": [],
    id: crypto.randomUUID(),
    title,
  };
}
