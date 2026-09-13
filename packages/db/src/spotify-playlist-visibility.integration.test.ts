import type { SpotifyPlaylistItemSnapshot } from "@radar/providers";
import { spotifyAuthorizedPlaylistId } from "@radar/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { oauthAccounts, users } from "./schema";
import {
  executeSpotifyPlaylistVisibility,
  previewSpotifyPlaylistVisibility,
  type SpotifyPlaylistVisibilityClient,
} from "./spotify-playlist-visibility";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(databaseUrl);
const db = connection.db;

describe.sequential("Spotify authorized playlist visibility", () => {
  beforeEach(async () => {
    await db.execute(sql`truncate table users, playlist_targets restart identity cascade`);
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("changes only visibility and preserves the verified Custom Order snapshot", async () => {
    const userId = await createUserWithWriteScopes();
    const state = new FakeVisibilityState(false);

    const preview = await previewSpotifyPlaylistVisibility(
      db,
      userId,
      state.client(),
      spotifyAuthorizedPlaylistId,
    );
    expect(preview.target).toMatchObject({
      collaborative: false,
      currentPublic: false,
      expectedPublic: true,
      itemCount: 3,
      ownerVerified: true,
    });
    expect(preview.verification.customOrderMovesRequired).toBe(0);
    expect(state.visibilityWrites).toBe(0);

    const execution = await executeSpotifyPlaylistVisibility(db, userId, state.client(), {
      playlistId: spotifyAuthorizedPlaylistId,
      policy: { allowedPlaylistId: spotifyAuthorizedPlaylistId, enabled: true },
    });
    expect(execution.result).toMatchObject({
      addedAtAndAddedByPreserved: true,
      artworkPreserved: true,
      customOrderPreserved: true,
      descriptionPreserved: true,
      itemCountAfter: 3,
      itemCountBefore: 3,
      itemMultisetPreserved: true,
      itemOrderPreserved: true,
      namePreserved: true,
      ownerPreserved: true,
      publicAfter: true,
      publicBefore: false,
      snapshotCacheReconciled: true,
      visibilityUpdated: true,
    });
    expect(state.visibilityWrites).toBe(1);
    expect(state.isPublic).toBe(true);
    expect(state.items).toEqual(state.originalItems);
    const target = await db.query.playlistTargets.findFirst();
    expect(target).toMatchObject({
      providerPlaylistId: spotifyAuthorizedPlaylistId,
      snapshotId: "snapshot-1",
    });
    expect(target?.snapshotItems).toHaveLength(3);
  });

  it("is idempotent when the authorized playlist is already public", async () => {
    const userId = await createUserWithWriteScopes();
    const state = new FakeVisibilityState(true);

    const execution = await executeSpotifyPlaylistVisibility(db, userId, state.client(), {
      playlistId: spotifyAuthorizedPlaylistId,
      policy: { allowedPlaylistId: spotifyAuthorizedPlaylistId, enabled: true },
    });
    expect(execution.result).toMatchObject({ publicAfter: true, visibilityUpdated: false });
    expect(state.visibilityWrites).toBe(0);
  });

  it("rejects disabled writes, missing scopes, and every other playlist before mutation", async () => {
    const userId = await createUserWithWriteScopes();
    const state = new FakeVisibilityState(false);
    await expect(
      executeSpotifyPlaylistVisibility(db, userId, state.client(), {
        playlistId: spotifyAuthorizedPlaylistId,
        policy: { allowedPlaylistId: spotifyAuthorizedPlaylistId, enabled: false },
      }),
    ).rejects.toMatchObject({ code: "writes_disabled" });
    await expect(
      executeSpotifyPlaylistVisibility(db, userId, state.client(), {
        playlistId: "abcdefghijklmnopqrstuv",
        policy: { allowedPlaylistId: spotifyAuthorizedPlaylistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(state.requestCount).toBe(0);
    expect(state.visibilityWrites).toBe(0);

    const userWithoutScopes = await createUserWithWriteScopes(["playlist-modify-private"]);
    const scopeState = new FakeVisibilityState(false);
    await expect(
      executeSpotifyPlaylistVisibility(db, userWithoutScopes, scopeState.client(), {
        playlistId: spotifyAuthorizedPlaylistId,
        policy: { allowedPlaylistId: spotifyAuthorizedPlaylistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "writes_disabled" });
    expect(scopeState.requestCount).toBe(0);
  });
});

class FakeVisibilityState {
  readonly originalItems: SpotifyPlaylistItemSnapshot[];
  readonly items: SpotifyPlaylistItemSnapshot[];
  requestCount = 0;
  visibilityWrites = 0;

  constructor(public isPublic: boolean) {
    this.items = [
      item("new-track", 0, "2026-08-08", "2026-08-08T12:00:00.000Z"),
      item("old-track", 1, "2026-08-01", "2026-08-01T12:00:00.000Z"),
      item("user-track", 2, undefined, "2020-01-01T00:00:00.000Z"),
    ];
    this.originalItems = structuredClone(this.items);
  }

  client(): SpotifyPlaylistVisibilityClient {
    return {
      getCurrentUser: () => {
        this.requestCount += 1;
        return Promise.resolve({
          account_id: "owner-account",
          display_name: "Owner",
          external_urls: { spotify: "https://open.spotify.com/user/owner" },
          id: "owner",
          type: "user",
          uri: "spotify:user:owner",
        });
      },
      getPlaylist: (id) => {
        this.requestCount += 1;
        return Promise.resolve({
          collaborative: false,
          description: "Release Inbox",
          external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
          id,
          images: [{ height: 640, url: "https://i.scdn.co/image/test", width: 640 }],
          name: "Release Radar Inbox",
          owner: { account_id: "owner-account", id: "owner" },
          public: this.isPublic,
          snapshot_id: "snapshot-1",
          uri: `spotify:playlist:${id}`,
        });
      },
      getPlaylistItems: () => {
        this.requestCount += 1;
        return Promise.resolve(structuredClone(this.items));
      },
      setAuthorizedPlaylistPublic: (id) => {
        this.requestCount += 1;
        expect(id).toBe(spotifyAuthorizedPlaylistId);
        this.visibilityWrites += 1;
        this.isPublic = true;
        return Promise.resolve();
      },
    };
  }
}

async function createUserWithWriteScopes(
  scopes: string[] = ["playlist-modify-private", "playlist-modify-public"],
): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ displayName: "Owner", email: `owner-${crypto.randomUUID()}@example.test` })
    .returning();
  if (!user) throw new Error("Test user was not created.");
  await db.insert(oauthAccounts).values({
    provider: "spotify",
    providerAccountId: `spotify-${user.id}`,
    scopes: ["user-follow-read", "playlist-read-private", ...scopes],
    userId: user.id,
  });
  return user.id;
}

function item(
  trackId: string,
  position: number,
  releaseDate: string | undefined,
  addedAt: string,
): SpotifyPlaylistItemSnapshot {
  return {
    addedAt,
    addedById: "owner",
    ...(releaseDate ? { releaseDate } : {}),
    position,
    title: trackId,
    trackId,
  };
}
