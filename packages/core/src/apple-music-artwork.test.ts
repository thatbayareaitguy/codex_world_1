import { describe, expect, it } from "vitest";
import {
  normalizeAppleMusicAlbumUrl,
  normalizeAppleMusicArtworkUrl,
  parseAppleMusicReleaseArtwork,
} from "./apple-music-artwork";

describe("Apple Music artwork safety", () => {
  it("expands an Apple artwork template on an allowlisted host", () => {
    expect(
      normalizeAppleMusicArtworkUrl(
        "https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/example/{w}x{h}bb.jpg",
        300,
        300,
      ),
    ).toBe("https://is1-ssl.mzstatic.com/image/thumb/Music126/v4/example/300x300bb.jpg");
  });

  it("rejects lookalike artwork and album hosts", () => {
    expect(
      normalizeAppleMusicArtworkUrl("https://is1-ssl.mzstatic.com.evil.test/a.jpg"),
    ).toBeNull();
    expect(
      normalizeAppleMusicAlbumUrl("https://music.apple.com.evil.test/us/album/example/123", "123"),
    ).toBeNull();
  });

  it("parses a complete namespaced artwork record", () => {
    expect(
      parseAppleMusicReleaseArtwork({
        albumId: "123",
        albumUrl: "https://music.apple.com/us/album/example/123",
        image: {
          height: 300,
          url: "https://is2-ssl.mzstatic.com/image/thumb/example/300x300bb.jpg",
          width: 300,
        },
        lastObservedAt: "2026-08-04T12:00:00.000Z",
        sourceProvider: "apple_music",
      }),
    ).not.toBeNull();
  });

  it("accepts a safe Apple album URL from another storefront", () => {
    expect(normalizeAppleMusicAlbumUrl("https://music.apple.com/gb/album/example/123", "123")).toBe(
      "https://music.apple.com/gb/album/example/123",
    );
  });
});
