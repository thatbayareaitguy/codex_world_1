import { describe, expect, it } from "vitest";
import {
  abbreviateSpotifyPlaylistId,
  assertOwnedNonCollaborativeSpotifyPlaylist,
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

  it.each([false, true, null])(
    "requires the connected owner and a non-collaborative playlist at visibility %s",
    (publicState) => {
      expect(() =>
        assertOwnedNonCollaborativeSpotifyPlaylist(
          {
            collaborative: false,
            owner: { account_id: "owner" },
            public: publicState,
          },
          { account_id: "owner", id: "user" },
        ),
      ).not.toThrow();
    },
  );

  it("rejects an unowned or collaborative target regardless of visibility", () => {
    expect(() =>
      assertOwnedNonCollaborativeSpotifyPlaylist(
        { collaborative: false, owner: { account_id: "other" }, public: true },
        { account_id: "owner", id: "user" },
      ),
    ).toThrow("not owned");
    expect(() =>
      assertOwnedNonCollaborativeSpotifyPlaylist(
        { collaborative: true, owner: { account_id: "owner" }, public: false },
        { account_id: "owner", id: "user" },
      ),
    ).toThrow("Collaborative");
  });
});
