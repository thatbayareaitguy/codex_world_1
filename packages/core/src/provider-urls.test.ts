import { describe, expect, it } from "vitest";
import {
  safeProviderEvidenceUrl,
  spotifyTrackIdFromUrl,
  validateProviderEvidenceUrl,
} from "./provider-urls";

describe("provider evidence URLs", () => {
  it("accepts catalog Apple Music evidence and rejects lookalike hosts", () => {
    expect(
      safeProviderEvidenceUrl(
        "apple_music",
        "https://music.apple.com/us/album/example-release/123456789",
      ),
    ).toBe("https://music.apple.com/us/album/example-release/123456789");
    expect(
      safeProviderEvidenceUrl(
        "apple_music",
        "https://music.apple.com.evil.test/us/album/example-release/123456789",
      ),
    ).toBeNull();
  });

  it("accepts only expected Spotify web entities with base62 IDs", () => {
    expect(
      safeProviderEvidenceUrl("spotify", "https://open.spotify.com/track/0123456789ABCDEFGHIJKL"),
    ).toContain("open.spotify.com/track/");
    for (const value of [
      "http://open.spotify.com/track/0123456789ABCDEFGHIJKL",
      "https://user@open.spotify.com/track/0123456789ABCDEFGHIJKL",
      "https://open.spotify.com:444/track/0123456789ABCDEFGHIJKL",
      "https://open.spotify.example/track/0123456789ABCDEFGHIJKL",
      "https://127.0.0.1/track/0123456789ABCDEFGHIJKL",
      "https://open.spotify.com/track/not-an-id",
      "javascript:alert(1)",
    ]) {
      expect(validateProviderEvidenceUrl("spotify", value).valid).toBe(false);
    }
  });

  it("extracts only a safe Spotify track ID", () => {
    expect(
      spotifyTrackIdFromUrl("https://open.spotify.com/track/0123456789ABCDEFGHIJKL?si=synthetic"),
    ).toBe("0123456789ABCDEFGHIJKL");
    expect(
      spotifyTrackIdFromUrl("https://open.spotify.com/album/0123456789ABCDEFGHIJKL"),
    ).toBeNull();
    expect(
      spotifyTrackIdFromUrl("https://open.spotify.example/track/0123456789ABCDEFGHIJKL"),
    ).toBeNull();
  });

  it("accepts MusicBrainz entity paths only with valid MBIDs", () => {
    expect(
      validateProviderEvidenceUrl(
        "musicbrainz",
        "https://musicbrainz.org/release-group/00000000-0000-4000-8000-000000000001",
      ).valid,
    ).toBe(true);
    expect(
      validateProviderEvidenceUrl("musicbrainz", "https://musicbrainz.org/search?query=unsafe")
        .valid,
    ).toBe(false);
    expect(
      validateProviderEvidenceUrl(
        "musicbrainz",
        "https://musicbrainz.example/recording/00000000-0000-4000-8000-000000000001",
      ).valid,
    ).toBe(false);
  });

  it("keeps Reddit evidence on supported Reddit comment URLs", () => {
    expect(
      validateProviderEvidenceUrl(
        "reddit",
        "https://www.reddit.com/r/dnb/comments/abc123/synthetic_release/",
      ).valid,
    ).toBe(true);
    expect(validateProviderEvidenceUrl("reddit", "https://reddit.example/comments/abc").valid).toBe(
      false,
    );
  });

  it("uses the existing strict SoundCloud track validator", () => {
    expect(
      validateProviderEvidenceUrl("soundcloud", "https://soundcloud.com/artist/track").valid,
    ).toBe(true);
    expect(validateProviderEvidenceUrl("soundcloud", "https://soundcloud.com/artist").valid).toBe(
      false,
    );
    expect(
      validateProviderEvidenceUrl("soundcloud", "https://soundcloud.example/artist/track").valid,
    ).toBe(false);
  });

  it("allows conservative HTTPS URLs only for genuinely generic providers", () => {
    expect(validateProviderEvidenceUrl("mock", "https://example.test/evidence/item").valid).toBe(
      true,
    );
    expect(validateProviderEvidenceUrl("mock", "https://localhost/evidence/item").valid).toBe(
      false,
    );
    expect(validateProviderEvidenceUrl("mock", "data:text/plain,unsafe").valid).toBe(false);
    expect(
      validateProviderEvidenceUrl("youtube", "https://www.youtube.com/watch?v=synthetic").valid,
    ).toBe(false);
  });
});
