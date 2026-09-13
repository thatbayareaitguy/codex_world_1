import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as rejectPlaylistConfiguration } from "./playlists/route";
import { POST as synchronizePlaylist } from "./playlist-sync/route";

const request = (path: string, body?: string) =>
  new NextRequest(`http://127.0.0.1:3000${path}`, {
    ...(body ? { body } : {}),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      origin: "http://127.0.0.1:3000",
    },
    method: "POST",
  });

afterEach(() => vi.unstubAllEnvs());

describe("Spotify playlist route boundary", () => {
  it("keeps playlist creation and configuration unavailable", async () => {
    const response = rejectPlaylistConfiguration(request("/api/spotify/playlists", "{}"));
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      error:
        "Playlist creation, selection, rename, visibility changes, artwork, follow, and unfollow are unavailable",
    });
  });

  it("rejects browser-supplied playlist IDs before configuration or database access", async () => {
    const response = await synchronizePlaylist(
      request(
        "/api/spotify/playlist-sync",
        JSON.stringify({ playlistId: "abcdefghijklmnopqrstuv" }),
      ),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Spotify playlist-write routes do not accept a request body",
    });
  });

  it("rejects body-free synchronization while writes are disabled", async () => {
    vi.stubEnv("SPOTIFY_PLAYLIST_WRITES_ENABLED", "false");
    vi.stubEnv("SPOTIFY_ALLOWED_PLAYLIST_ID", "4l6LaMPL6duulmFe3hRR4Y");
    const response = await synchronizePlaylist(request("/api/spotify/playlist-sync"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Spotify playlist writes are disabled",
    });
  });
});
