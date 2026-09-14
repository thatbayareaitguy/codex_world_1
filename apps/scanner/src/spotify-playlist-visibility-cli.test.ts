import { describe, expect, it } from "vitest";
import { parseSpotifyPlaylistVisibilityMode } from "./spotify-playlist-visibility-cli";

describe("Spotify playlist visibility CLI", () => {
  it("accepts one explicit mode", () => {
    expect(parseSpotifyPlaylistVisibilityMode(["--dry-run"])).toBe("dry-run");
    expect(parseSpotifyPlaylistVisibilityMode(["--", "--live"])).toBe("live");
  });

  it("rejects missing, conflicting, and unknown options", () => {
    expect(() => parseSpotifyPlaylistVisibilityMode([])).toThrow();
    expect(() => parseSpotifyPlaylistVisibilityMode(["--dry-run", "--live"])).toThrow();
    expect(() => parseSpotifyPlaylistVisibilityMode(["--playlist", "another"])).toThrow();
  });
});
