import { describe, expect, it } from "vitest";
import { parseSpotifyPlaylistOrderMode } from "./spotify-playlist-order-cli";

describe("Spotify playlist Custom Order CLI", () => {
  it.each([
    ["--dry-run", "dry-run"],
    ["--canary", "canary"],
    ["--live", "live"],
  ])("accepts the explicit %s mode", (argument, expected) => {
    expect(parseSpotifyPlaylistOrderMode(["--", argument])).toBe(expected);
  });

  it("rejects missing, combined, and arbitrary modes", () => {
    expect(() => parseSpotifyPlaylistOrderMode([])).toThrow("exactly one");
    expect(() => parseSpotifyPlaylistOrderMode(["--dry-run", "--live"])).toThrow("exactly one");
    expect(() => parseSpotifyPlaylistOrderMode(["--playlist-id", "other"])).toThrow("exactly one");
  });
});
