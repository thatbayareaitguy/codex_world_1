import {
  createDatabase,
  createSpotifyRequestGate,
  defaultSpotifyRollingRequestBudget,
  executeSpotifyPlaylistExport,
  getSpotifySchedulerStatus,
  inspectSpotifyPlaylistCheckpoint,
  operationLocks,
  providerCache,
  spotifyProviderState,
  spotifyRequestEvents,
  SpotifyEndpointBudgetError,
  SpotifyPlaylistSnapshotYieldError,
  users,
  oauthAccounts,
  artists,
  releases,
  tracks,
  trackCredits,
  artistFollows,
  releaseTrackAppearances,
  releaseCandidates,
  feedItems,
  acquireSpotifyPlaylistWriterLock,
  guardSpotifyPlaylistWriterClient,
  releaseSpotifyPlaylistWriterLock,
} from "@radar/db";
import {
  SpotifyClient,
  withProviderExecutionBudget,
  type SpotifyRequestPermit,
} from "@radar/providers";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decideDiscoveryMaintenance } from "./discovery-maintenance";
import { runDiscoveryMaintenanceLoop } from "./discovery-maintenance-cli";
import { claimMaintenanceEpisode, inspectMaintenanceEpisode } from "./maintenance-episode";

const connection = createDatabase(
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test",
);
const db = connection.db;
const playlistId = "4l6LaMPL6duulmFe3hRR4Y";

describe.sequential("playlist delivery across real maintenance capacity decisions", () => {
  beforeEach(async () => {
    await db.delete(providerCache);
    await db.delete(operationLocks);
    await db.delete(spotifyRequestEvents);
    await db.delete(spotifyProviderState);
    await db.execute(
      sql`truncate table users, artists, releases, release_candidates, playlist_targets restart identity cascade`,
    );
  });
  afterAll(async () => {
    await connection.client.end();
  });

  it.each([0, 1400])(
    "finishes 1500-item readback from offset %i and eleven additions without early-wake waiting",
    async (savedOffset) => {
      const directory = mkdtempSync(join(tmpdir(), "radar-capacity-recovery-"));
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-14T03:50:00Z"));
      const original = Array.from({ length: 1500 }, (_, index) =>
        String(10000 + index).padStart(22, "0"),
      );
      const remote = [...original];
      const readyIds = Array.from({ length: 11 }, (_, index) =>
        String(index + 1).padStart(22, "0"),
      );
      const offsets: number[] = [];
      const additions: string[] = [];
      const starts: number[] = [];
      let version = 1;
      try {
        const [owner] = await db
          .insert(users)
          .values({ displayName: "Capacity fixture", email: "capacity@example.test" })
          .returning();
        if (!owner) throw new Error("Missing fixture owner");
        await db.insert(oauthAccounts).values({
          userId: owner.id,
          provider: "spotify",
          providerAccountId: "owner-account",
          providerUserId: "owner",
          scopes: ["playlist-modify-public", "playlist-modify-private"],
        });
        for (const [index, id] of readyIds.entries()) {
          const [artist] = await db
            .insert(artists)
            .values({ name: `Synthetic ${index}`, normalizedName: `synthetic ${index}` })
            .returning();
          const [release] = await db
            .insert(releases)
            .values({
              title: `Synthetic ${index}`,
              normalizedTitle: `synthetic ${index}`,
              releaseDate: `2026-09-${String(12 - index).padStart(2, "0")}`,
              releaseDatePrecision: "day",
              releaseType: "single",
            })
            .returning();
          const [track] = await db
            .insert(tracks)
            .values({ title: `Synthetic ${index}`, normalizedTitle: `synthetic ${index}` })
            .returning();
          if (!artist || !release || !track) throw new Error("Missing fixture identity");
          await db.insert(trackCredits).values({
            trackId: track.id,
            artistId: artist.id,
            creditOrder: 0,
            creditedName: artist.name,
            role: "primary",
          });
          await db.insert(artistFollows).values({ artistId: artist.id, userId: owner.id });
          const [appearance] = await db
            .insert(releaseTrackAppearances)
            .values({ trackId: track.id, releaseId: release.id, discNumber: 1, trackNumber: 1 })
            .returning();
          const [candidate] = await db
            .insert(releaseCandidates)
            .values({
              provider: "spotify",
              providerTrackId: id,
              artistExternalId: `artist-${id}`,
              providerReleaseId: `release-${id}`,
              title: track.title,
              normalizedTitle: track.normalizedTitle,
              payloadHash: id,
              rawPayload: {},
              matchedTrackId: track.id,
              matchStatus: "matched",
              matchConfidence: "1.000",
              matchRule: "exact_isrc",
              matchReasons: ["synthetic exact evidence"],
              firstSeenAt: new Date(),
              releaseDate: release.releaseDate,
            })
            .returning();
          if (!appearance || !candidate) throw new Error("Missing fixture evidence");
          await db.insert(feedItems).values({
            userId: owner.id,
            trackId: track.id,
            releaseId: release.id,
            appearanceId: appearance.id,
            candidateId: candidate.id,
            dedupeKey: id,
            firstSeenAt: new Date(),
            state: "new",
          });
        }
        // Twenty preceding requests leave ten starts in the first launch. Completing
        // the readback and real client's ownership checks requires both recoveries.
        await db.insert(spotifyRequestEvents).values(
          Array.from({ length: 20 }, (_, index) => ({
            endpointCategory: "oauth_or_other",
            method: "GET",
            quotaLane: "priority",
            status: 200,
            startedAt: new Date(Date.now() - (20 - index) * 10_000),
          })),
        );
        if (savedOffset > 0) {
          await db.insert(providerCache).values({
            provider: "spotify",
            cacheKey: `playlist-snapshot-refresh:${owner.id}:${playlistId}`,
            expiresAt: new Date(Date.now() + 86400000),
            value: {
              playlistId,
              snapshotId: "snapshot-1",
              startedAt: new Date().toISOString(),
              nextOffset: savedOffset,
              items: original.slice(0, savedOffset).map((trackId, position) => ({
                position,
                trackId,
                addedAt: "2020-01-01T00:00:00Z",
                addedById: "original-owner",
                releaseDate: "2020-01-01",
                title: trackId,
              })),
            },
          });
        }
        const fetcher: typeof fetch = async (input, init) => {
          const url = new URL(
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          );
          const method = init?.method ?? "GET";
          const respond = (body: unknown) =>
            Promise.resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          if (url.pathname === "/v1/me" && method === "GET")
            return respond({
              id: "owner",
              account_id: "owner-account",
              display_name: "Fixture",
              external_urls: { spotify: "https://open.spotify.com/user/owner" },
              type: "user",
              uri: "spotify:user:owner",
            });
          if (url.pathname === `/v1/playlists/${playlistId}` && method === "GET")
            return respond({
              id: playlistId,
              name: "Fixture",
              collaborative: false,
              public: true,
              owner: { id: "owner", account_id: "owner-account" },
              snapshot_id: `snapshot-${version}`,
              external_urls: { spotify: `https://open.spotify.com/playlist/${playlistId}` },
              uri: `spotify:playlist:${playlistId}`,
            });
          if (url.pathname === `/v1/playlists/${playlistId}/items` && method === "GET") {
            const offset = Number(url.searchParams.get("offset"));
            offsets.push(offset);
            const artist = {
              id: "fixture-artist",
              name: "Fixture",
              type: "artist",
              uri: "spotify:artist:fixture-artist",
              external_urls: { spotify: "https://open.spotify.com/artist/fixture-artist" },
            };
            return respond({
              href: url.href,
              limit: 50,
              offset,
              total: remote.length,
              next:
                offset + 50 < remote.length
                  ? `${url.origin}${url.pathname}?offset=${offset + 50}&limit=50`
                  : null,
              items: remote.slice(offset, offset + 50).map((id) => ({
                added_at: "2020-01-01T00:00:00Z",
                added_by: { id: "original-owner" },
                item: {
                  id,
                  name: id,
                  artists: [artist],
                  disc_number: 1,
                  track_number: 1,
                  duration_ms: 180000,
                  explicit: false,
                  type: "track",
                  uri: `spotify:track:${id}`,
                  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
                  album: {
                    id: "fixture-album",
                    name: "Fixture",
                    album_type: "album",
                    artists: [artist],
                    release_date: "2020-01-01",
                    release_date_precision: "day",
                    total_tracks: 1500,
                    type: "album",
                    uri: "spotify:album:fixture-album",
                    external_urls: { spotify: "https://open.spotify.com/album/fixture-album" },
                  },
                },
              })),
            });
          }
          if (url.pathname === `/v1/playlists/${playlistId}/items` && method === "POST") {
            if (typeof init?.body !== "string") throw new Error("Expected JSON fixture request");
            const body = JSON.parse(init.body) as { position: number; uris: string[] };
            const ids = body.uris.map((uri) => uri.replace("spotify:track:", ""));
            expect(ids.length).toBeLessThanOrEqual(3);
            additions.push(...ids);
            remote.splice(body.position, 0, ...ids);
            version += 1;
            return respond({ snapshot_id: `snapshot-${version}` });
          }
          throw new Error(`Unexpected synthetic HTTP route: ${method} ${url.pathname}`);
        };
        for (let launch = 0; launch < 3 && additions.length < 11; launch += 1) {
          const episode = claimMaintenanceEpisode(`capacity-${launch}`, {
            directory,
            processAlive: () => false,
          });
          if (!episode) throw new Error("Recovery incorrectly refused");
          const gate = createSpotifyRequestGate(db, 10000, undefined, undefined, {
            quotaLane: "playlist",
            rollingRequestBudget: defaultSpotifyRollingRequestBudget,
            rollingCapacityWait: {
              maximumWaitMs: 900000,
              deadlineAt: episode.deadlineAt,
              sleep: (ms) => {
                vi.setSystemTime(Date.now() + ms);
                return Promise.resolve();
              },
            },
          });
          // Serialize fake-clock advancement at the real database gate, including
          // the actual client's concurrent profile/ownership checks before writes.
          let tail = Promise.resolve();
          const releasesByPermit = new Map<string, () => void>();
          const client = new SpotifyClient({
            accessToken: () => Promise.resolve("synthetic-token"),
            fetcher,
            playlistWritePolicy: { enabled: true, allowedPlaylistId: playlistId },
            requestGate: {
              acquire: async (input) => {
                const before = tail;
                let unlock = () => {};
                tail = new Promise<void>((resolve) => {
                  unlock = resolve;
                });
                await before;
                vi.setSystemTime(Date.now() + 10000);
                try {
                  const permit = await gate.acquire(input);
                  starts.push(permit.startedAt.getTime());
                  releasesByPermit.set(permit.leaseToken, unlock);
                  return permit;
                } catch (error) {
                  unlock();
                  throw error;
                }
              },
              complete: async (permit: SpotifyRequestPermit, result) => {
                try {
                  await gate.complete(permit, result);
                } finally {
                  releasesByPermit.get(permit.leaseToken)?.();
                  releasesByPermit.delete(permit.leaseToken);
                }
              },
            },
          });
          let wake: Date | null = null;
          await withProviderExecutionBudget(
            { signal: new AbortController().signal, reserveCapacityWait: episode.reserveWait },
            async () => {
              await runDiscoveryMaintenanceLoop({
                maximumRuntimeMs: episode.deadlineAt.getTime() - Date.now(),
                now: () => new Date(),
                acquirePower: () => ({ release: async () => {} }),
                reserveWait: episode.reserveWait,
                sleep: (ms) => {
                  vi.setSystemTime(Date.now() + ms);
                  return Promise.resolve();
                },
                updateWake: (at) => {
                  wake = episode.recoveryWake(at);
                  return Promise.resolve();
                },
                updateStartupRecoveryWake: async () => {},
                observe: async (now) => {
                  const delivery = await inspectSpotifyPlaylistCheckpoint(
                    db,
                    owner.id,
                    playlistId,
                    {
                      now,
                      recordReady: true,
                    },
                  );
                  return decideDiscoveryMaintenance(
                    {
                      apple: {
                        cooldownActive: false,
                        cooldownIndefinite: false,
                        cooldownUntil: null,
                        leaseActive: false,
                        nextRequestAt: null,
                      },
                      discovery: {
                        actionable: null,
                        full: { latest: null, next: null },
                        catchup: { latest: null, next: null },
                        phase: "playlist_inbox",
                        playlistInbox: { pendingCount: 0, status: "partial", delivery },
                      },
                      spotify: await getSpotifySchedulerStatus(db, now),
                    },
                    now,
                  );
                },
                runTick: async () => {
                  const lock = await acquireSpotifyPlaylistWriterLock(db);
                  try {
                    await executeSpotifyPlaylistExport(
                      db,
                      owner.id,
                      guardSpotifyPlaylistWriterClient(db, lock, client),
                      {
                        playlistId,
                        policy: { allowedPlaylistId: playlistId, enabled: true },
                        maxAdditions: 3,
                        maxMutations: 3,
                        maxPlaylistReadPages: 6,
                      },
                    );
                  } catch (error) {
                    if (
                      !(error instanceof SpotifyPlaylistSnapshotYieldError) &&
                      !(error instanceof SpotifyEndpointBudgetError)
                    )
                      throw error;
                  } finally {
                    await releaseSpotifyPlaylistWriterLock(db, lock);
                  }
                },
              });
            },
          );
          episode.finish();
          if (wake) vi.setSystemTime(wake);
        }
        expect(additions).toEqual(readyIds);
        expect(remote).toEqual([...readyIds, ...original]);
        expect(new Set(remote).size).toBe(1511);
        expect(offsets).toEqual(
          Array.from({ length: (1500 - savedOffset) / 50 }, (_, index) => savedOffset + index * 50),
        );
        expect(
          starts.every((start, index) => index === 0 || start - starts[index - 1]! >= 10000),
        ).toBe(true);
        const status = inspectMaintenanceEpisode(new Date(), {
          directory,
          processAlive: () => false,
        });
        expect(status.launches).toBe(savedOffset === 0 ? 3 : 2);
        expect(status.capacityWaitMs).toBeLessThan(5 * 60000);
        expect(status.holdMs).toBeLessThanOrEqual(235 * 60000);
        const target = await db.query.playlistTargets.findFirst();
        expect(
          target?.snapshotItems
            ?.slice(11)
            .every(
              (item) =>
                item.addedById === "original-owner" && item.addedAt === "2020-01-01T00:00:00Z",
            ),
        ).toBe(true);
        expect(target?.snapshotVerifiedAt).toBeNull();
      } finally {
        vi.useRealTimers();
        rmSync(directory, { recursive: true, force: true });
      }
    },
    60000,
  );
});
