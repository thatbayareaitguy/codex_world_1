import { describe, expect, it } from "vitest";
import {
  parseAppleIdentityCsv,
  parseAppleMusicArtistId,
  serializeAppleIdentityBatch,
} from "./apple-music-identity-workflow";

describe("Apple Music identity CSV workflow", () => {
  it("parses only safe numeric IDs and Apple artist URLs", () => {
    expect(parseAppleMusicArtistId("455181031")).toBe("455181031");
    expect(parseAppleMusicArtistId("https://music.apple.com/us/artist/amc/455181031")).toBe(
      "455181031",
    );
    expect(() => parseAppleMusicArtistId("javascript:alert(1)")).toThrow();
    expect(() => parseAppleMusicArtistId("https://music.apple.example/artist/455181031")).toThrow();
    expect(() =>
      parseAppleMusicArtistId("https://user@music.apple.com/us/artist/amc/455181031"),
    ).toThrow();
    expect(() =>
      parseAppleMusicArtistId("https://music.apple.com/us/album/example/455181031"),
    ).toThrow();
  });

  it("exports the required provider-neutral columns without Spotify evidence", () => {
    const csv = serializeAppleIdentityBatch([
      {
        appleCandidateUrls: ["https://music.apple.com/us/artist/123"],
        artistId: "11111111-1111-4111-8111-111111111111",
        candidateCount: 1,
        displayName: "Example Artist",
        musicBrainzId: "22222222-2222-4222-8222-222222222222",
        resolutionStatus: "requires_manual_decision",
      },
    ]);
    expect(csv).toContain("canonical_artist_id");
    expect(csv).toContain("apple_music_url_or_id");
    expect(csv.toLowerCase()).not.toContain("spotify");
    expect(parseAppleIdentityCsv(csv)).toHaveLength(1);
  });

  it("rejects templates with missing required columns", () => {
    expect(() => parseAppleIdentityCsv("canonical_artist_id\nabc\n")).toThrow(
      "CSV is missing required columns",
    );
  });
});
