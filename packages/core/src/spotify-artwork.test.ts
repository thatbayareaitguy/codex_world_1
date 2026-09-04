import { describe, expect, it } from "vitest";
import {
  normalizeSpotifyAlbumUrl,
  normalizeSpotifyArtworkUrl,
  parseSpotifyReleaseArtwork,
  selectClosestSpotifyArtwork,
} from "./spotify-artwork";

describe("Spotify artwork metadata", () => {
  it("accepts only the documented Spotify image host over HTTPS", () => {
    expect(normalizeSpotifyArtworkUrl("https://i.scdn.co/image/abc123")).toBe(
      "https://i.scdn.co/image/abc123",
    );
    for (const url of [
      "http://i.scdn.co/image/abc123",
      "https://user@i.scdn.co/image/abc123",
      "https://i.scdn.co/image/abc123?tracking=1",
      "https://127.0.0.1/image/abc123",
      "https://i.scdn.co.example.com/image/abc123",
      "javascript:alert(1)",
      "not a URL",
    ]) {
      expect(normalizeSpotifyArtworkUrl(url), url).toBeNull();
    }
  });

  it("requires the applicable canonical Spotify album link", () => {
    expect(normalizeSpotifyAlbumUrl("https://open.spotify.com/album/album123", "album123")).toBe(
      "https://open.spotify.com/album/album123",
    );
    expect(
      normalizeSpotifyAlbumUrl("https://open.spotify.com/track/album123", "album123"),
    ).toBeNull();
  });

  it("selects the image closest to 300 square and preserves dimensions", () => {
    expect(selectClosestSpotifyArtwork([])).toBeUndefined();
    expect(
      selectClosestSpotifyArtwork([
        { height: 640, url: "https://i.scdn.co/image/large", width: 640 },
        { height: 64, url: "https://i.scdn.co/image/small", width: 64 },
        { height: 300, url: "https://i.scdn.co/image/medium", width: 300 },
      ]),
    ).toEqual({ height: 300, url: "https://i.scdn.co/image/medium", width: 300 });
  });

  it("uses the first image when dimensions are unavailable", () => {
    expect(
      selectClosestSpotifyArtwork([
        { height: null, url: "https://i.scdn.co/image/first", width: null },
        { height: null, url: "https://i.scdn.co/image/second", width: null },
      ]),
    ).toMatchObject({ url: "https://i.scdn.co/image/first" });
  });

  it("parses safe namespaced provider metadata and rejects malformed values", () => {
    const metadata = {
      albumId: "album123",
      albumUrl: "https://open.spotify.com/album/album123",
      image: { height: 300, url: "https://i.scdn.co/image/abc123", width: 300 },
      lastObservedAt: "2026-07-20T12:00:00.000Z",
      sourceProvider: "spotify",
    };
    expect(parseSpotifyReleaseArtwork(metadata)).toEqual(metadata);
    expect(parseSpotifyReleaseArtwork({ ...metadata, sourceProvider: "musicbrainz" })).toBeNull();
    expect(
      parseSpotifyReleaseArtwork({
        ...metadata,
        image: { ...metadata.image, url: "https://example.com/image.jpg" },
      }),
    ).toBeNull();
  });
});
