import type { SpotifyPlaylistItemSnapshot, SpotifyPlaylistReorderInput } from "@radar/providers";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { oauthAccounts, users } from "./schema";
import {
  executeSpotifyPlaylistCustomOrder,
  hasVerifiedSpotifyPlaylistOrderCanary,
  previewSpotifyPlaylistCustomOrder,
  type SpotifyPlaylistOrderClient,
} from "./spotify-playlist-order";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(databaseUrl);
const db = connection.db;
const playlistId = "1234567890123456789012";

describe.sequential("Spotify playlist Custom Order", () => {
  beforeEach(async () => {
    await db.execute(sql`truncate table users, playlist_targets restart identity cascade`);
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("preserves Date Added through a canary and resumes the remaining plan after restart", async () => {
    const userId = await createUserWithWriteScopes();
    const state = new FakeOrderState([
      item("old-2", 0, "2026-01-01", "old", 2),
      item("new-2", 1, "2026-08-08", "new", 2),
      item("old-1", 2, "2026-01-01", "old", 1),
      item("new-1", 3, "2026-08-08", "new", 1),
      {
        addedAt: "2020-01-01T00:00:00.000Z",
        addedById: "owner",
        position: 4,
        title: "User track",
        trackId: "user-track",
      },
    ]);
    const beforeAddedAt = state.items.map((entry) => [entry.trackId, entry.addedAt]);

    const preview = await previewSpotifyPlaylistCustomOrder(db, userId, state.client(), playlistId);
    expect(preview.plan.moves.length).toBeGreaterThan(1);
    expect(preview.plan.desiredItems.map((entry) => entry.trackId)).toEqual([
      "new-1",
      "new-2",
      "old-1",
      "old-2",
      "user-track",
    ]);

    const canary = await executeSpotifyPlaylistCustomOrder(db, userId, state.client(), {
      canary: true,
      forceRefresh: true,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(canary.result).toMatchObject({
      addedAtPreserved: true,
      itemMultisetPreserved: true,
      operationsPerformed: 1,
    });
    await expect(hasVerifiedSpotifyPlaylistOrderCanary(db, userId, playlistId)).resolves.toBe(true);

    const restartedClient = state.client();
    const completed = await executeSpotifyPlaylistCustomOrder(db, userId, restartedClient, {
      canary: false,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(completed.cacheHit).toBe(true);
    expect(completed.result).toMatchObject({
      addedAtPreserved: true,
      itemMultisetPreserved: true,
      remainingMoves: 0,
    });
    expect(state.items.map((entry) => entry.trackId)).toEqual([
      "new-1",
      "new-2",
      "old-1",
      "old-2",
      "user-track",
    ]);
    expect(state.items.map((entry) => [entry.trackId, entry.addedAt]).sort()).toEqual(
      beforeAddedAt.sort(),
    );
    expect(state.items.filter((entry) => entry.trackId === "user-track")).toHaveLength(1);
  });

  it("rejects disabled writes and every playlist except the allowlisted target", async () => {
    const userId = await createUserWithWriteScopes();
    const state = new FakeOrderState([item("track", 0, "2026-08-08", "album", 1)]);

    await expect(
      executeSpotifyPlaylistCustomOrder(db, userId, state.client(), {
        canary: true,
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: false },
      }),
    ).rejects.toMatchObject({ code: "writes_disabled" });
    await expect(
      executeSpotifyPlaylistCustomOrder(db, userId, state.client(), {
        canary: true,
        playlistId: "abcdefghijklmnopqrstuv",
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(state.requestCount).toBe(0);
    expect(state.reorderCalls).toHaveLength(0);
  });
});

class FakeOrderState {
  readonly reorderCalls: SpotifyPlaylistReorderInput[] = [];
  requestCount = 0;
  private snapshot = 1;

  constructor(readonly items: SpotifyPlaylistItemSnapshot[]) {}

  client(): SpotifyPlaylistOrderClient {
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
          external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
          id,
          name: "Release Radar Inbox",
          owner: { account_id: "owner-account", id: "owner" },
          public: false,
          snapshot_id: `snapshot-${this.snapshot}`,
          uri: `spotify:playlist:${id}`,
        });
      },
      getPlaylistItems: () => {
        this.requestCount += 1;
        return Promise.resolve(this.items.map((entry) => ({ ...entry })));
      },
      reorderPlaylistItems: (_id, input) => {
        this.requestCount += 1;
        this.reorderCalls.push({ ...input });
        const moved = this.items.splice(input.rangeStart, input.rangeLength);
        const insertAt =
          input.insertBefore > input.rangeStart
            ? input.insertBefore - input.rangeLength
            : input.insertBefore;
        this.items.splice(insertAt, 0, ...moved);
        this.items.forEach((entry, position) => {
          entry.position = position;
        });
        this.snapshot += 1;
        return Promise.resolve(`snapshot-${this.snapshot}`);
      },
    };
  }
}

async function createUserWithWriteScopes(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ displayName: "Owner", email: "owner@example.test" })
    .returning();
  if (!user) throw new Error("Test user was not created.");
  await db.insert(oauthAccounts).values({
    provider: "spotify",
    providerAccountId: "spotify-owner",
    scopes: [
      "user-follow-read",
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
    ],
    userId: user.id,
  });
  return user.id;
}

function item(
  trackId: string,
  position: number,
  releaseDate: string,
  albumId: string,
  trackNumber: number,
): SpotifyPlaylistItemSnapshot {
  return {
    addedAt: `2026-08-08T00:00:0${position}.000Z`,
    addedById: "owner",
    albumId,
    albumTitle: `Album ${albumId}`,
    discNumber: 1,
    position,
    releaseDate,
    title: trackId,
    trackId,
    trackNumber,
  };
}
