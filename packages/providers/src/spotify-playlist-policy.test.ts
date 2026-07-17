import { describe, expect, it } from "vitest";
import {
  abbreviateSpotifyPlaylistId,
  assertOwnedPrivateSpotifyPlaylist,
  assertSpotifyPlaylistWriteTarget,
  assertSpotifyTrackIds,
} from "./spotify-playlist-policy";

const allowedPlaylistId = "1234567890123456789012";

describe("Spotify playlist write policy", () => {
  it("defaults to denying writes and requires one valid configured ID", () => {
    expect(() => assertSpotifyPlaylistWriteTarget({ enabled: false }, allowedPlaylistId)).toThrow(
      "disabled",
    );
    expect(() => assertSpotifyPlaylistWriteTarget({ enabled: true }, allowedPlaylistId)).toThrow(
      "required",
    );
    expect(() =>
      assertSpotifyPlaylistWriteTarget(
        { allowedPlaylistId: "invalid", enabled: true },
        allowedPlaylistId,
      ),
    ).toThrow("malformed");
  });

  it("accepts only the configured target and valid track IDs", () => {
    expect(
      assertSpotifyPlaylistWriteTarget({ allowedPlaylistId, enabled: true }, allowedPlaylistId),
    ).toBe(allowedPlaylistId);
    expect(() => assertSpotifyTrackIds(["0000000000000000000001"])).not.toThrow();
    expect(() => assertSpotifyTrackIds(["bad-track-id"])).toThrow("malformed track ID");
    expect(abbreviateSpotifyPlaylistId(allowedPlaylistId)).toBe("1234...9012");
  });

  it("requires the connected owner and a private non-collaborative playlist", () => {
    expect(() =>
      assertOwnedPrivateSpotifyPlaylist(
        {
          collaborative: false,
          owner: { account_id: "owner" },
          public: false,
        },
        { account_id: "owner", id: "user" },
      ),
    ).not.toThrow();
  });
});
