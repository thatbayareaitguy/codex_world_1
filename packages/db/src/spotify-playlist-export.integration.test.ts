import type { FeedState } from "@radar/core";
import { SpotifyHttpError, withProviderExecutionBudget } from "@radar/providers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiscoveryWorkTurn, recordDiscoveryWorkTurn } from "./discovery-work-turn";
import type { SpotifyPlaylistExportClient } from "./spotify-playlist-export";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "./client";
import {
  executeSpotifyPlaylistExport,
  inspectSpotifyPlaylistCheckpoint,
  previewSpotifyPlaylistExport,
  surfaceUncertainSpotifyMatchesForReview,
  verifySpotifyPlaylistCheckpoint,
} from "./spotify-playlist-export";
import {
  SpotifyCooldownError,
  SpotifyEndpointBudgetError,
  createSpotifyRequestGate,
  defaultSpotifyRollingRequestBudget,
} from "./spotify-request-gate";
import { SpotifyPlaylistMetadataLagError } from "./spotify-playlist-evidence";
import { SpotifyPlaylistSnapshotYieldError } from "./spotify-playlist-cache";
import {
  artistFollows,
  artists,
  discoveryReconciliationCampaigns,
  feedItems,
  manualMatchDecisions,
  oauthAccounts,
  playlistExports,
  playlistTargets,
  providerCache,
  releaseCandidates,
  releaseProviderReconciliations,
  releases,
  releaseTrackAppearances,
  spotifyPlaylistExportOperations,
  spotifyPlaylistExportRuns,
  trackCredits,
  tracks,
  users,
  spotifyProviderState,
  spotifyRequestEvents,
} from "./schema";

const databaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://radar:radar@127.0.0.1:5433/radar_test";
const connection = createDatabase(databaseUrl);
const db = connection.db;
const playlistId = "4l6LaMPL6duulmFe3hRR4Y";
// Black-box application boundary: do not pull application source into the database
// package's compilation root. This contract describes only the public test surface.
interface EpisodeContract {
  deadlineAt: Date;
  reserveWait: (milliseconds: number) => void;
  recoveryWake: (requested: Date | null) => Date | null;
  finish: () => void;
}
const episodeModulePath = "../../../apps/scanner/src/maintenance-episode";
const { claimMaintenanceEpisode, inspectMaintenanceEpisode } = (await import(
  episodeModulePath
)) as {
  claimMaintenanceEpisode: (
    runId: string,
    options: { directory: string; processAlive: () => boolean },
  ) => EpisodeContract | null;
  inspectMaintenanceEpisode: (
    now: Date,
    options: { directory: string; processAlive: () => boolean },
  ) => { launches: number; capacityWaitMs: number; holdMs: number };
};

describe.sequential("Spotify canonical playlist export", () => {
  beforeEach(async () => {
    await db.delete(providerCache);
    await db.execute(
      sql`truncate table users, artists, releases, release_candidates, playlist_targets restart identity cascade`,
    );
  });

  afterAll(async () => {
    await connection.client.end();
  });

  it("simulates Thu-Fri bounded delivery over 1500 items with the configured gate, restart, lag and uncertain writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-weekly-cycle-"));
    vi.useFakeTimers({ toFake: ["Date"] });
    const fixedWindows = ["2026-09-11T03:50:00Z", "2026-09-11T15:50:00Z", "2026-09-12T03:50:00Z"];
    vi.setSystemTime(new Date(fixedWindows[0]!));
    await db.delete(spotifyRequestEvents);
    await db.delete(spotifyProviderState);
    const fixture = await createExactBatchFixture(17);
    // Matching starts unresolved; a synthetic exact match is persisted after each
    // gated matching request. No real HTTP or provider account is involved.
    await db.update(releaseCandidates).set({ matchConfidence: "0.700", matchRule: "metadata" });
    const original = Array.from({ length: 1500 }, (_, index) =>
      String(10000 + index).padStart(22, "0"),
    );
    let loseResponse = true;
    const raw = new FakePlaylistClient([...original], undefined, 50, () => {
      if (loseResponse) {
        loseResponse = false;
        return new Error("synthetic lost write acknowledgment");
      }
      return undefined;
    });
    const originalProvenance = (await raw.getPlaylistItems()).map(
      ({ trackId, addedAt, addedById }) => ({ trackId, addedAt, addedById }),
    );
    let matched = 0;
    let lagInjected = false;
    let editInjected = false;
    let initialPages: number | null = null;
    let totalUnits = 0;
    const requestStarts: number[] = [];
    try {
      for (const fixed of fixedWindows) {
        vi.setSystemTime(new Date(fixed));
        for (let launch = 0; launch < 3; launch += 1) {
          const episode = claimMaintenanceEpisode(`simulation-${fixed}-${launch}`, {
            directory,
            processAlive: () => false,
          });
          if (!episode) break;
          const signal = new AbortController().signal;
          const playlistGate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
            quotaLane: "playlist",
            rollingRequestBudget: defaultSpotifyRollingRequestBudget,
            rollingCapacityWait: {
              maximumWaitMs: 900_000,
              deadlineAt: episode.deadlineAt,
              sleep: (milliseconds) => {
                vi.setSystemTime(Date.now() + milliseconds);
                return Promise.resolve();
              },
            },
          });
          const matchingGate = createSpotifyRequestGate(db, 10_000, undefined, undefined, {
            quotaLane: "priority",
            rollingRequestBudget: defaultSpotifyRollingRequestBudget,
          });
          const request = async <T>(method: string, callback: () => Promise<T>) => {
            vi.setSystemTime(Date.now() + 10_000);
            const gate = method === "MATCH" ? matchingGate : playlistGate;
            const permit = await gate.acquire({
              endpointCategory:
                method === "MATCH"
                  ? "track_resolution"
                  : method === "GET"
                    ? "playlist_read"
                    : "playlist_write",
              method: method === "MATCH" ? "GET" : method,
            });
            requestStarts.push(permit.startedAt.getTime());
            try {
              return await callback();
            } finally {
              await gate.complete(permit, { status: 200 });
            }
          };
          const client: SpotifyPlaylistExportClient = {
            getCurrentUser: () => request("GET", () => raw.getCurrentUser()),
            getPlaylist: (id) => request("GET", () => raw.getPlaylist(id)),
            getPlaylistItems: () => request("GET", () => raw.getPlaylistItems()),
            getPlaylistItemsPage: (id, offset) =>
              request("GET", () => raw.getPlaylistItemsPage(id, offset)),
            addPlaylistItemsAtPosition: (id, ids, position) =>
              request("POST", () => raw.addPlaylistItemsAtPosition(id, ids, position)),
            reorderPlaylistItems: (id, move) =>
              request("PUT", () => raw.reorderPlaylistItems(id, move)),
          };
          const recovery: { at: Date | null } = { at: null };
          await withProviderExecutionBudget(
            { signal, reserveCapacityWait: episode.reserveWait },
            async () => {
              for (
                let unit = 0;
                unit < 100 && Date.now() < episode.deadlineAt.getTime();
                unit += 1
              ) {
                totalUnits += 1;
                const inspection = await inspectSpotifyPlaylistCheckpoint(
                  db,
                  fixture.userId,
                  playlistId,
                  { recordReady: true },
                );
                const last = await getDiscoveryWorkTurn(db);
                try {
                  if (matched < 17 && (last === "delivery" || !inspection.shouldDeliver)) {
                    await request("MATCH", async () => {
                      await db
                        .update(releaseCandidates)
                        .set({ matchConfidence: "1.000", matchRule: "exact_isrc" })
                        .where(
                          eq(releaseCandidates.providerTrackId, fixture.providerTrackIds[matched]!),
                        );
                    });
                    matched += 1;
                    await recordDiscoveryWorkTurn(db, "matching");
                  } else if (
                    inspection.workKind === "uncertain" ||
                    inspection.workKind === "verification"
                  ) {
                    await recordDiscoveryWorkTurn(db, "delivery");
                    await verifySpotifyPlaylistCheckpoint(
                      db,
                      fixture.userId,
                      client,
                      playlistId,
                      6,
                    );
                    initialPages ??= raw.pageReadOffsets.length;
                  } else if (inspection.shouldDeliver) {
                    await recordDiscoveryWorkTurn(db, "delivery");
                    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
                      playlistId,
                      policy: { enabled: true, allowedPlaylistId: playlistId },
                      maxAdditions: 3,
                      maxMutations: 3,
                      maxPlaylistReadPages: 6,
                    });
                    expect(result.run.additionsAttempted).toBeLessThanOrEqual(3);
                    if (!lagInjected && raw.addCalls.length > 1) {
                      raw.reportedSnapshotId = "snapshot-2";
                      lagInjected = true;
                    }
                  } else if (inspection.flushDeadlineAt && matched === 17) {
                    vi.setSystemTime(
                      Math.max(Date.now() + 10_000, Date.parse(inspection.flushDeadlineAt)),
                    );
                  } else if (matched === 17 && !editInjected) {
                    raw.externalInsert("8888888888888888888888", raw.items.length);
                    editInjected = true;
                    await verifySpotifyPlaylistCheckpoint(
                      db,
                      fixture.userId,
                      client,
                      playlistId,
                      6,
                    );
                  } else if (matched === 17) break;
                } catch (error) {
                  if (error instanceof SpotifyPlaylistSnapshotYieldError) continue;
                  if (error instanceof SpotifyPlaylistMetadataLagError) {
                    const pages = raw.pageReadOffsets.length;
                    raw.reportedSnapshotId = null;
                    vi.setSystemTime(error.checkNotBefore);
                    expect(raw.pageReadOffsets.length).toBe(pages);
                    continue;
                  }
                  if (error instanceof SpotifyEndpointBudgetError) {
                    recovery.at = error.nextCapacityAt;
                    break;
                  }
                  if (
                    error instanceof Error &&
                    error.message === "synthetic lost write acknowledgment"
                  )
                    continue;
                  throw error;
                }
              }
            },
          );
          // One simulated crash leaves no finish marker. A fresh owner must retain
          // the same deadline, launch count, and wait reservations.
          if (launch !== 0) episode.finish();
          if (!recovery.at || !episode.recoveryWake(recovery.at)) break;
          vi.setSystemTime(recovery.at.getTime() + 1);
        }
        const status = inspectMaintenanceEpisode(new Date(), {
          directory,
          processAlive: () => false,
        });
        expect(status.launches).toBeLessThanOrEqual(3);
        expect(status.capacityWaitMs).toBeLessThanOrEqual(900_000);
        expect(status.holdMs).toBeLessThanOrEqual(235 * 60_000);
      }
      expect(matched).toBe(17);
      expect(initialPages).toBe(30);
      expect(lagInjected && editInjected).toBe(true);
      expect(raw.items).toHaveLength(1518);
      expect(new Set(raw.items).size).toBe(1518);
      expect(raw.items.slice(0, 17)).toEqual(fixture.providerTrackIds);
      expect(raw.items.filter((id) => original.includes(id))).toEqual(original);
      expect(
        (await raw.getPlaylistItems())
          .filter((item) => original.includes(item.trackId))
          .map(({ trackId, addedAt, addedById }) => ({ trackId, addedAt, addedById })),
      ).toEqual(originalProvenance);
      expect(raw.addCalls.flatMap((call) => call.trackIds)).toHaveLength(17);
      expect(raw.pageReadOffsets.filter((offset) => offset === 0).length).toBeLessThanOrEqual(5);
      expect(totalUnits).toBeLessThan(100);
      expect(
        requestStarts.every(
          (value, index) => index === 0 || value - requestStarts[index - 1]! >= 10_000,
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("previews canonical exact and manual matches while caching the verified snapshot", async () => {
    const fixture = await createFixture({ includeIneligible: true, writeScope: false });
    const client = new FakePlaylistClient(["9999999999999999999999"]);

    const preview = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);

    expect(preview.target).toMatchObject({ id: playlistId, public: true });
    expect(preview.plan.desired.map((item) => item.title)).toEqual([
      "Exact track",
      "Confirmed track",
    ]);
    expect(preview.plan.additions.map((item) => item.position)).toEqual([0, 1]);
    expect(preview.plan.skips.map((item) => item.reason).sort()).toEqual([
      "duplicate_recording_appearance",
      "feed_dismissed",
      "needs_review",
      "not_followed_artist",
      "uncertain_spotify_match",
    ]);
    expect(client.items).toEqual(["9999999999999999999999"]);
    await expect(tableCount(playlistTargets)).resolves.toBe(1);
    await expect(tableCount(playlistExports)).resolves.toBe(0);
    await expect(tableCount(spotifyPlaylistExportRuns)).resolves.toBe(0);
    await expect(tableCount(spotifyPlaylistExportOperations)).resolves.toBe(0);
  });

  it("avoids playlist-item pagination while the remote snapshot is unchanged", async () => {
    const fixture = await createFixture({ writeScope: false });
    const client = new FakePlaylistClient(["9999999999999999999999"]);

    const first = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);
    const second = await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(client.itemReadCalls).toBe(1);
    client.externalInsert("8888888888888888888888", 0);
    const afterExternalChange = await previewSpotifyPlaylistExport(
      db,
      fixture.userId,
      client,
      playlistId,
    );
    expect(afterExternalChange.cacheHit).toBe(false);
    expect(client.itemReadCalls).toBe(2);
  });

  it("uses cached database state to skip no-change checkpoints and surface uncertain matches", async () => {
    const fixture = await createFixture({ includeIneligible: true, writeScope: false });
    const verifiedAt = new Date("2026-08-19T04:00:00.000Z");
    const client = new FakePlaylistClient([
      fixture.exactProviderTrackId,
      fixture.confirmedProviderTrackId,
    ]);
    await previewSpotifyPlaylistExport(db, fixture.userId, client, playlistId);
    await db
      .update(playlistTargets)
      .set({ snapshotVerifiedAt: verifiedAt })
      .where(eq(playlistTargets.userId, fixture.userId));

    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId, {
        now: new Date(verifiedAt.getTime() + 60_000),
      }),
    ).resolves.toMatchObject({
      exportedCount: 2,
      pendingAdditionCount: 0,
      reason: "none",
      reorderMoveCount: 0,
      shouldRun: false,
    });
    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId, {
        now: new Date(verifiedAt.getTime() + 25 * 60 * 60_000),
      }),
    ).resolves.toMatchObject({ reason: "periodic_reconciliation", shouldRun: true });

    await expect(
      surfaceUncertainSpotifyMatchesForReview(db, fixture.userId, verifiedAt),
    ).resolves.toMatchObject({ candidatesUpdated: 1, feedItemsUpdated: 1 });
    const uncertain = await db.query.releaseCandidates.findFirst({
      where: eq(releaseCandidates.title, "Uncertain track"),
    });
    const uncertainFeed = uncertain
      ? await db.query.feedItems.findFirst({ where: eq(feedItems.candidateId, uncertain.id) })
      : undefined;
    expect(uncertain).toMatchObject({ matchStatus: "needs_review" });
    expect(uncertainFeed).toMatchObject({ state: "needs_review" });
  });

  it("restores release-date Custom Order from cache without a second full playlist read", async () => {
    const fixture = await createFixture({ writeScope: true });
    const client = new FakePlaylistClient([
      fixture.confirmedProviderTrackId,
      fixture.exactProviderTrackId,
    ]);
    await db.insert(playlistTargets).values({
      name: "Release Radar Inbox",
      provider: "spotify",
      providerPlaylistId: playlistId,
      snapshotId: "snapshot-1",
      snapshotItems: [
        {
          addedAt: "2026-08-01T00:00:00.000Z",
          position: 0,
          releaseDate: "2026-07-31",
          trackId: fixture.confirmedProviderTrackId,
        },
        {
          addedAt: "2026-08-02T00:00:00.000Z",
          position: 1,
          releaseDate: "2026-08-01",
          trackId: fixture.exactProviderTrackId,
        },
      ],
      snapshotVerifiedAt: new Date(),
      userId: fixture.userId,
    });

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.cacheHit).toBe(true);
    expect(client.items).toEqual([fixture.exactProviderTrackId, fixture.confirmedProviderTrackId]);
    expect(client.reorderCalls).toBe(1);
    expect(client.itemReadCalls).toBe(0);
    const target = await db.query.playlistTargets.findFirst();
    expect(target?.snapshotItems?.map((item) => item.addedAt)).toEqual([
      "2026-08-02T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    ]);
  });

  it("blocks an allowlist mismatch and missing write scope before any Spotify call", async () => {
    const fixture = await createFixture({ writeScope: false });
    const mismatchClient = new FakePlaylistClient([]);
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, mismatchClient, {
        playlistId: "abcdefghijklmnopqrstuv",
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "playlist_id_mismatch" });
    expect(mismatchClient.readCalls).toBe(0);
    expect(mismatchClient.addCalls).toHaveLength(0);

    const scopeClient = new FakePlaylistClient([]);
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, scopeClient, {
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "missing_write_scope" });
    expect(scopeClient.readCalls).toBe(0);
    expect(scopeClient.addCalls).toHaveLength(0);
  });

  it("blocks live export when only the private playlist modification scope is stored", async () => {
    const fixture = await createFixture({ writeScope: true });
    await db
      .update(oauthAccounts)
      .set({ scopes: ["user-follow-read", "playlist-read-private", "playlist-modify-private"] })
      .where(eq(oauthAccounts.userId, fixture.userId));
    const client = new FakePlaylistClient([]);

    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, {
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
      }),
    ).rejects.toMatchObject({ code: "missing_write_scope" });
    expect(client.readCalls).toBe(0);
    expect(client.addCalls).toHaveLength(0);
  });

  it("resumes a canary, reconciles a post-write crash, preserves user tracks, and remains idempotent", async () => {
    const fixture = await createFixture({ writeScope: true });
    const userTrack = "9999999999999999999999";
    const client = new FakePlaylistClient([userTrack]);

    const canary = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      maxAdditions: 1,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(canary.run).toMatchObject({ additionsAttempted: 1, pending: 1, status: "partial" });
    expect(client.items).toEqual([fixture.exactProviderTrackId, userTrack]);
    expect(client.addCalls).toHaveLength(1);

    client.externalInsert(fixture.confirmedProviderTrackId, 1);
    const resumed = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(resumed.run).toMatchObject({
      additionsAttempted: 0,
      pending: 0,
      resumed: true,
      status: "completed",
    });
    expect(resumed.run.id).toBe(canary.run.id);
    expect(client.addCalls).toHaveLength(1);
    expect(client.items).toEqual([
      fixture.exactProviderTrackId,
      fixture.confirmedProviderTrackId,
      userTrack,
    ]);

    const repeat = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(repeat.run).toMatchObject({ additionsAttempted: 0, status: "completed" });
    expect(client.addCalls).toHaveLength(1);
    expect(client.itemReadCalls).toBe(2);
    expect(new Set(client.items).size).toBe(client.items.length);
    expect(client.items.filter((item) => item === userTrack)).toHaveLength(1);

    const ledger = await db
      .select({
        appOwned: playlistExports.appOwned,
        providerTrackId: playlistExports.providerTrackId,
      })
      .from(playlistExports)
      .orderBy(playlistExports.providerTrackId);
    expect(ledger).toEqual([
      { appOwned: true, providerTrackId: fixture.exactProviderTrackId },
      { appOwned: false, providerTrackId: fixture.confirmedProviderTrackId },
    ]);
  });

  it.each([1, 3, 4, 10, 17])(
    "bounds and resumes a %i-item automatic export without duplicates",
    async (trackCount) => {
      const fixture = await createExactBatchFixture(trackCount);
      const userTrack = "9999999999999999999999";
      const client = new FakePlaylistClient([userTrack]);
      const runIds = new Set<string>();
      let invocationCount = 0;
      let result: Awaited<ReturnType<typeof executeSpotifyPlaylistExport>>;

      do {
        const mutationCallsBefore = client.addCalls.length + client.reorderCalls;
        result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
          maxAdditions: 3,
          maxMutations: 3,
          orderingPolicy: "release_date_custom_order",
          playlistId,
          policy: { allowedPlaylistId: playlistId, enabled: true },
        });
        invocationCount += 1;
        runIds.add(result.run.id);
        expect(result.run.additionsAttempted).toBeLessThanOrEqual(3);
        expect(
          client.addCalls.length + client.reorderCalls - mutationCallsBefore,
        ).toBeLessThanOrEqual(3);
      } while (result.run.status !== "completed");

      expect(invocationCount).toBe(Math.ceil(trackCount / 3));
      expect(client.itemReadCalls).toBe(1);
      expect((await db.query.playlistTargets.findFirst())?.snapshotVerifiedAt).toBeNull();
      expect(runIds.size).toBe(1);
      expect(client.items).toEqual([...fixture.providerTrackIds, userTrack]);
      expect(new Set(client.items).size).toBe(client.items.length);
      expect(client.addCalls.flatMap((call) => call.trackIds)).toEqual(fixture.providerTrackIds);
      await expect(tableCount(spotifyPlaylistExportRuns)).resolves.toBe(1);
      expect(
        await db.query.spotifyPlaylistExportOperations.findMany({
          where: eq(spotifyPlaylistExportOperations.status, "pending"),
        }),
      ).toHaveLength(0);
    },
  );

  it("preserves the client receiver and resumes bounded snapshot pages without rereading", async () => {
    const fixture = await createExactBatchFixture(1);
    const existingTracks = Array.from({ length: 5 }, (_, index) =>
      String(900 + index).padStart(22, "0"),
    );
    const client = new FakePlaylistClient([...existingTracks], undefined, 2);
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      maxPlaylistReadPages: 1,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };

    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, input),
    ).rejects.toMatchObject({ name: "SpotifyPlaylistSnapshotYieldError", nextOffset: 2 });
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, input),
    ).rejects.toMatchObject({ name: "SpotifyPlaylistSnapshotYieldError", nextOffset: 4 });
    const added = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);

    expect(added.run).toMatchObject({ additionsAttempted: 1, status: "completed" });
    expect(client.pageReadOffsets).toEqual([0, 2, 4]);
    expect(client.items).toEqual([fixture.providerTrackIds[0], ...existingTracks]);
    const completed = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(completed.run).toMatchObject({
      additionsAttempted: 0,
      status: "completed",
    });
    expect(client.pageReadOffsets).toEqual([0, 2, 4]);
    expect((await db.query.playlistTargets.findFirst())?.snapshotVerifiedAt).toBeNull();
  });

  it("makes durable snapshot progress when only one playlist request is available per checkpoint", async () => {
    const fixture = await createExactBatchFixture(1);
    const existingTracks = Array.from({ length: 5 }, (_, index) =>
      String(900 + index).padStart(22, "0"),
    );
    const client = new FakePlaylistClient([...existingTracks], undefined, 2);
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      maxPlaylistReadPages: 6,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };
    const added = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      maxAdditions: input.maxAdditions,
      maxMutations: input.maxMutations,
      orderingPolicy: input.orderingPolicy,
      playlistId: input.playlistId,
      policy: input.policy,
    });
    expect(added.run).toMatchObject({ additionsAttempted: 1, status: "completed" });
    client.externalInsert("8888888888888888888888", client.items.length);
    const playlistReadsBefore = client.playlistReadCalls;
    let completed: Awaited<ReturnType<typeof executeSpotifyPlaylistExport>> | null = null;
    let invocations = 0;

    while (!completed && invocations < 10) {
      invocations += 1;
      client.grantRequests(1);
      try {
        const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
        if (result.run.status === "completed") completed = result;
      } catch (error) {
        expect(error).toBeInstanceOf(SpotifyEndpointBudgetError);
      }
    }

    expect(completed?.run).toMatchObject({
      additionsAttempted: 0,
      pending: 0,
      status: "completed",
    });
    expect(invocations).toBe(6);
    expect(client.pageReadOffsets).toEqual([0, 2, 4, 6]);
    expect(client.playlistReadCalls - playlistReadsBefore).toBe(2);
    expect(client.profileReadCalls).toBe(0);
    expect(client.addCalls).toHaveLength(1);
    expect(new Set(client.items).size).toBe(client.items.length);
    await expect(tableCount(providerCache)).resolves.toBe(0);
  });

  it("bounds reorder mutations and resumes the same run until Custom Order is correct", async () => {
    const fixture = await createExactBatchFixture(10);
    const client = new FakePlaylistClient([...fixture.providerTrackIds].reverse());
    const runIds = new Set<string>();
    let result: Awaited<ReturnType<typeof executeSpotifyPlaylistExport>>;
    let invocationCount = 0;

    do {
      result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
        maxAdditions: 3,
        maxMutations: 3,
        orderingPolicy: "release_date_custom_order",
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
      });
      runIds.add(result.run.id);
      invocationCount += 1;
      expect(client.reorderCalls).toBeLessThanOrEqual(invocationCount * 3);
      if (invocationCount > 10) throw new Error("Bounded ordering did not converge.");
    } while (result.run.status !== "completed");

    expect(runIds.size).toBe(1);
    expect(client.items).toEqual(fixture.providerTrackIds);
    expect(new Set(client.items).size).toBe(client.items.length);
  });

  it("defers a partial reorder while a recorded predecessor snapshot is returned", async () => {
    const fixture = await createExactBatchFixture(10);
    const unmanagedTrack = "9999999999999999999999";
    const client = new FakePlaylistClient([
      unmanagedTrack,
      ...fixture.providerTrackIds.slice().reverse(),
    ]);
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      maxPlaylistReadPages: 6,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };

    const first = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(first.run).toMatchObject({ additionsAttempted: 0, status: "partial" });
    const pageReadsAfterFirstTick = client.pageReadOffsets.length;
    const itemMetadataAfterFirstTick = await loadPlaylistItemMetadata(fixture.userId);

    client.reportedSnapshotId = "snapshot-1";
    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, input),
    ).rejects.toMatchObject({ name: "SpotifyPlaylistMetadataLagError" });
    expect(client.pageReadOffsets).toHaveLength(pageReadsAfterFirstTick);
    expect(client.reorderCalls).toBe(3);
    expect(await loadPlaylistItemMetadata(fixture.userId)).toEqual(itemMetadataAfterFirstTick);

    client.reportedSnapshotId = null;
    let completed = first;
    while (completed.run.status !== "completed") {
      completed = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    }

    expect(completed.run.id).toBe(first.run.id);
    expect(client.items).toEqual([...fixture.providerTrackIds, unmanagedTrack]);
    expect(new Set(client.items).size).toBe(client.items.length);
    expect(await loadPlaylistItemMetadata(fixture.userId)).toEqual(itemMetadataAfterFirstTick);
  });

  it("invalidates the local snapshot when a conditional reorder proves it is stale", async () => {
    const fixture = await createExactBatchFixture(10);
    const client = new FakePlaylistClient(fixture.providerTrackIds.slice().reverse());
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      maxPlaylistReadPages: 6,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };

    const first = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(first.run.status).toBe("partial");
    client.reportedSnapshotId = "stale-playlist-metadata-snapshot";
    client.externalInsert("8888888888888888888888", 0);

    await expect(executeSpotifyPlaylistExport(db, fixture.userId, client, input)).rejects.toThrow(
      "synthetic snapshot conflict",
    );
    const target = await db.query.playlistTargets.findFirst({
      where: eq(playlistTargets.userId, fixture.userId),
    });
    expect(target).toMatchObject({ snapshotId: null, snapshotItems: null });
  });

  it("does not trust a lagging metadata snapshot while additions remain pending", async () => {
    const fixture = await createExactBatchFixture(10);
    const client = new FakePlaylistClient([], undefined, 2);
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      maxPlaylistReadPages: 1,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };

    const first = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(first.run).toMatchObject({ additionsAttempted: 3, pending: 7, status: "partial" });
    const pageReadsAfterFirstTick = client.pageReadOffsets.length;
    client.reportedSnapshotId = "stale-playlist-metadata-snapshot";

    await expect(
      executeSpotifyPlaylistExport(db, fixture.userId, client, input),
    ).rejects.toMatchObject({ name: "SpotifyPlaylistSnapshotYieldError", nextOffset: 2 });
    expect(client.pageReadOffsets).toHaveLength(pageReadsAfterFirstTick + 1);
    expect(client.addCalls).toHaveLength(3);
  });

  it("falls back to individual additions, records one failure, and continues", async () => {
    const fixture = await createFixture({ includeThirdExact: true, writeScope: true });
    const client = new FakePlaylistClient([], (trackIds) => {
      if (trackIds.length > 1) return new SpotifyHttpError("synthetic batch failure", 400);
      if (trackIds[0] === fixture.confirmedProviderTrackId) {
        return new SpotifyHttpError("synthetic item failure", 400);
      }
      return undefined;
    });

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.run).toMatchObject({ exported: 2, failed: 1, pending: 0, status: "partial" });
    expect(client.items).toEqual([fixture.exactProviderTrackId, fixture.thirdProviderTrackId]);
    const failed = await db.query.spotifyPlaylistExportOperations.findFirst({
      where: and(
        eq(spotifyPlaylistExportOperations.providerTrackId, fixture.confirmedProviderTrackId),
        eq(spotifyPlaylistExportOperations.status, "failed"),
      ),
    });
    expect(failed).toMatchObject({ attemptCount: 2, errorCode: "spotify_http_400" });
  });

  it("reconciles an ambiguous post-write failure before retrying and never duplicates the track", async () => {
    const fixture = await createExactBatchFixture(1);
    const client = new FakePlaylistClient(
      [],
      undefined,
      50,
      () => new Error("synthetic connection loss after provider commit"),
    );
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    };

    await expect(executeSpotifyPlaylistExport(db, fixture.userId, client, input)).rejects.toThrow(
      "synthetic connection loss",
    );
    const interrupted = await db.query.spotifyPlaylistExportRuns.findFirst();
    expect(interrupted).toMatchObject({ status: "partial" });
    expect(client.items).toEqual(fixture.providerTrackIds);
    expect(client.addCalls).toHaveLength(1);

    const resumed = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(resumed.run).toMatchObject({
      additionsAttempted: 0,
      id: interrupted?.id,
      pending: 0,
      status: "completed",
    });
    expect(client.addCalls).toHaveLength(1);
    expect(client.items).toEqual(fixture.providerTrackIds);
    expect(new Set(client.items).size).toBe(client.items.length);
    const ledger = await db.query.playlistExports.findFirst({
      where: eq(playlistExports.providerTrackId, fixture.providerTrackIds[0]!),
    });
    expect(ledger).toMatchObject({ appOwned: true, status: "exported" });
  });

  it("makes an exhausted addition terminal without automatic provider churn", async () => {
    const fixture = await createExactBatchFixture(1);
    const client = new FakePlaylistClient([], () => new SpotifyHttpError("invalid item", 400));
    const input = {
      maxAdditions: 3,
      maxMutations: 3,
      orderingPolicy: "release_date_custom_order" as const,
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
      retryFailedExports: false,
    };

    const first = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    const second = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    const third = await executeSpotifyPlaylistExport(db, fixture.userId, client, input);
    expect(first.run.status).toBe("partial");
    expect(second.run).toMatchObject({ id: first.run.id, status: "partial" });
    expect(third.run).toMatchObject({ failed: 1, id: first.run.id, status: "failed" });
    expect(client.addCalls).toHaveLength(3);

    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId),
    ).resolves.toMatchObject({ blockedCount: 1, pendingAdditionCount: 0, shouldRun: false });
    expect(client.addCalls).toHaveLength(3);
    const terminal = await db.query.playlistExports.findFirst({
      where: eq(playlistExports.providerTrackId, fixture.providerTrackIds[0]!),
    });
    expect(terminal).toMatchObject({
      appOwned: true,
      errorCode: "playlist_addition_attempts_exhausted",
      status: "failed",
    });

    await db
      .update(playlistExports)
      .set({ errorCode: "spotify_http_500" })
      .where(eq(playlistExports.id, terminal!.id));
    await expect(
      inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId),
    ).resolves.toMatchObject({ blockedCount: 0, pendingAdditionCount: 1, shouldRun: true });
  });

  it.each([
    [
      "rolling capacity",
      () => new SpotifyEndpointBudgetError("rolling_requests", null, "playlist"),
    ],
    ["provider cooldown", () => new SpotifyCooldownError(new Date(Date.now() + 60_000), false)],
    ["rate limit response", () => new SpotifyHttpError("rate limited", 429)],
    [
      "token refresh rejection",
      () => new SpotifyHttpError("token rejected", 401, undefined, "oauth_token"),
    ],
  ])(
    "does not exhaust an addition after repeated %s failures before a playlist write",
    async (_label, failure) => {
      const fixture = await createExactBatchFixture(1);
      const client = new FakePlaylistClient([], () => failure());
      const input = {
        maxAdditions: 3,
        maxMutations: 3,
        orderingPolicy: "release_date_custom_order" as const,
        playlistId,
        policy: { allowedPlaylistId: playlistId, enabled: true },
        retryFailedExports: false,
      };

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await expect(
          executeSpotifyPlaylistExport(db, fixture.userId, client, input),
        ).rejects.toThrow();
      }

      const operation = await db.query.spotifyPlaylistExportOperations.findFirst({
        where: eq(spotifyPlaylistExportOperations.providerTrackId, fixture.providerTrackIds[0]!),
      });
      expect(operation).toMatchObject({ attemptCount: 0, errorCode: null, status: "pending" });
      await expect(
        inspectSpotifyPlaylistCheckpoint(db, fixture.userId, playlistId),
      ).resolves.toMatchObject({ blockedCount: 0, pendingOperationCount: 1, shouldRun: true });
      expect(client.items).toEqual([]);
      expect(client.addCalls).toHaveLength(4);
    },
  );

  it("exports only campaign-eligible tracks in release-date Custom Order", async () => {
    const fixture = await createFixture({ writeScope: true });
    const campaignId = crypto.randomUUID();
    await db.insert(discoveryReconciliationCampaigns).values({
      campaignKey: `playlist-inbox-${campaignId}`,
      effectiveConfiguration: {},
      id: campaignId,
      spotifyCohortSize: 1,
      spotifyPageLimit: 1,
      spotifyRotationSize: 0,
      totalArtists: 1,
      windowEnd: "2026-08-07",
      windowStart: "2026-07-08",
    });
    await db.insert(releaseProviderReconciliations).values({
      artistId: fixture.exactArtistId,
      campaignId,
      confidence: "1.000",
      playlistEligible: true,
      playlistEligibleTrackCount: 1,
      reconciliationKey: `eligible-${campaignId}`,
      releaseDate: "2026-08-01",
      releaseType: "single",
      reasons: ["Exact campaign-scoped playlist fixture"],
      spotifyCanonicalReleaseId: fixture.exactReleaseId,
      spotifyProviderReleaseId: `release-${fixture.exactProviderTrackId}`,
      status: "spotify_only",
      title: "Exact track Release",
    });
    const userTrack = "9999999999999999999999";
    const client = new FakePlaylistClient([userTrack]);

    const result = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      discoveryReconciliationCampaignId: campaignId,
      orderingPolicy: "release_date_custom_order",
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });

    expect(result.plan.desired.map((item) => item.providerTrackId)).toEqual([
      fixture.exactProviderTrackId,
    ]);
    expect(client.addCalls).toEqual([{ position: 0, trackIds: [fixture.exactProviderTrackId] }]);
    expect(client.items).toEqual([fixture.exactProviderTrackId, userTrack]);
    expect(client.itemReadCalls).toBe(1);
    expect(result.run.status).toBe("completed");
    const completed = await executeSpotifyPlaylistExport(db, fixture.userId, client, {
      discoveryReconciliationCampaignId: campaignId,
      orderingPolicy: "release_date_custom_order",
      playlistId,
      policy: { allowedPlaylistId: playlistId, enabled: true },
    });
    expect(
      await db.query.spotifyPlaylistExportRuns.findFirst({
        where: eq(spotifyPlaylistExportRuns.id, result.run.id),
      }),
    ).toMatchObject({
      discoveryReconciliationCampaignId: campaignId,
      orderingPolicy: "release_date_custom_order",
      status: "completed",
    });
    expect(completed.run.additionsAttempted).toBe(0);
    expect(client.itemReadCalls).toBe(1);
  });
});

class FakePlaylistClient implements SpotifyPlaylistExportClient {
  readonly addCalls: Array<{ position: number; trackIds: string[] }> = [];
  itemReadCalls = 0;
  readonly pageReadOffsets: number[] = [];
  playlistReadCalls = 0;
  profileReadCalls = 0;
  readCalls = 0;
  reportedSnapshotId: string | null = null;
  reorderCalls = 0;
  private snapshot = 1;
  private readonly addedAtByTrackId: Map<string, string>;
  private remainingRequests: number | null = null;

  constructor(
    readonly items: string[],
    private readonly fail?: (trackIds: string[]) => Error | undefined,
    private readonly pageSize = 50,
    private readonly failAfterWrite?: (trackIds: string[]) => Error | undefined,
  ) {
    this.addedAtByTrackId = new Map(
      items.map((trackId, index) => [
        trackId,
        new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      ]),
    );
  }

  getCurrentUser = () => {
    this.consumeRequest();
    this.profileReadCalls += 1;
    this.readCalls += 1;
    return Promise.resolve({
      account_id: "owner-account",
      display_name: "Owner",
      external_urls: { spotify: "https://open.spotify.com/user/owner" },
      id: "owner",
      type: "user" as const,
      uri: "spotify:user:owner",
    });
  };

  getPlaylist = (id: string) => {
    this.consumeRequest();
    this.playlistReadCalls += 1;
    this.readCalls += 1;
    return Promise.resolve({
      collaborative: false,
      external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
      id,
      name: "Release Radar Inbox",
      owner: { account_id: "owner-account", id: "owner" },
      public: true,
      snapshot_id: this.reportedSnapshotId ?? `snapshot-${this.snapshot}`,
      uri: `spotify:playlist:${id}`,
    });
  };

  getPlaylistItems = () => {
    this.consumeRequest();
    this.readCalls += 1;
    this.itemReadCalls += 1;
    return Promise.resolve(
      this.items.map((trackId, position) => this.snapshotItem(trackId, position)),
    );
  };

  getPlaylistItemsPage(_id: string, offset: number) {
    this.consumeRequest();
    this.readCalls += 1;
    this.pageReadOffsets.push(offset);
    const selected = this.items.slice(offset, offset + this.pageSize);
    return Promise.resolve({
      items: selected.map((trackId, index) => this.snapshotItem(trackId, offset + index)),
      nextOffset: offset + selected.length < this.items.length ? offset + selected.length : null,
    });
  }

  externalInsert(trackId: string, position: number): void {
    if (!this.addedAtByTrackId.has(trackId)) {
      this.addedAtByTrackId.set(trackId, new Date().toISOString());
    }
    this.items.splice(position, 0, trackId);
    this.snapshot += 1;
  }

  grantRequests(count: number): void {
    this.remainingRequests = count;
  }

  addPlaylistItemsAtPosition = (_id: string, trackIds: string[], position: number) => {
    this.consumeRequest();
    this.addCalls.push({ position, trackIds: [...trackIds] });
    const failure = this.fail?.(trackIds);
    if (failure) return Promise.reject(failure);
    for (const trackId of trackIds) {
      this.addedAtByTrackId.set(trackId, new Date().toISOString());
    }
    this.items.splice(position, 0, ...trackIds);
    this.snapshot += 1;
    const postWriteFailure = this.failAfterWrite?.(trackIds);
    if (postWriteFailure) return Promise.reject(postWriteFailure);
    return Promise.resolve(`snapshot-${this.snapshot}`);
  };

  reorderPlaylistItems = (
    _id: string,
    input: {
      insertBefore: number;
      rangeLength?: number;
      rangeStart: number;
      snapshotId: string;
    },
  ) => {
    this.consumeRequest();
    this.reorderCalls += 1;
    if (input.snapshotId !== `snapshot-${this.snapshot}`) {
      return Promise.reject(new SpotifyHttpError("synthetic snapshot conflict", 409));
    }
    const rangeLength = input.rangeLength ?? 1;
    const moved = this.items.splice(input.rangeStart, rangeLength);
    const adjustedInsert =
      input.insertBefore > input.rangeStart ? input.insertBefore - rangeLength : input.insertBefore;
    this.items.splice(adjustedInsert, 0, ...moved);
    this.snapshot += 1;
    return Promise.resolve(`snapshot-${this.snapshot}`);
  };

  private consumeRequest(): void {
    if (this.remainingRequests === null) return;
    if (this.remainingRequests <= 0) {
      throw new SpotifyEndpointBudgetError("rolling_requests", null, "playlist");
    }
    this.remainingRequests -= 1;
  }

  private snapshotItem(trackId: string, position: number) {
    const addedAt = this.addedAtByTrackId.get(trackId);
    return {
      ...(addedAt ? { addedAt } : {}),
      addedById: "synthetic-owner",
      position,
      trackId,
    };
  }
}

async function loadPlaylistItemMetadata(userId: string) {
  const target = await db.query.playlistTargets.findFirst({
    where: eq(playlistTargets.userId, userId),
  });
  return target?.snapshotItems
    ?.map((item) => ({ addedAt: item.addedAt, trackId: item.trackId }))
    .sort((left, right) => (left.trackId ?? "").localeCompare(right.trackId ?? ""));
}

async function createFixture(input: {
  includeIneligible?: boolean;
  includeThirdExact?: boolean;
  writeScope: boolean;
}) {
  const [user] = await db
    .insert(users)
    .values({ displayName: "Owner", email: "owner@example.test" })
    .returning();
  if (!user) throw new Error("Test user was not created.");
  await db.insert(oauthAccounts).values({
    provider: "spotify",
    providerAccountId: "owner-account",
    providerUserId: "owner",
    scopes: input.writeScope
      ? [
          "user-follow-read",
          "playlist-read-private",
          "playlist-modify-private",
          "playlist-modify-public",
        ]
      : ["user-follow-read", "playlist-read-private"],
    userId: user.id,
  });
  const exact = await createFeedTrack(user.id, {
    confidence: "1.000",
    feedState: "new",
    followed: true,
    matchRule: "new_canonical",
    providerTrackId: "0000000000000000000001",
    releaseDate: "2026-08-01",
    title: "Exact track",
  });
  const confirmed = await createFeedTrack(user.id, {
    confidence: "0.700",
    feedState: "new",
    followed: true,
    matchRule: "metadata",
    providerTrackId: "0000000000000000000002",
    releaseDate: "2026-07-31",
    title: "Confirmed track",
  });
  await db.insert(manualMatchDecisions).values({
    candidateId: confirmed.candidateId,
    decision: "confirm",
    reason: "Test confirmation",
    selectedTrackId: confirmed.trackId,
    userId: user.id,
  });
  let thirdProviderTrackId = "";
  if (input.includeThirdExact) {
    thirdProviderTrackId = "0000000000000000000003";
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "new",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: thirdProviderTrackId,
      releaseDate: "2026-07-30",
      title: "Third exact track",
    });
  }
  if (input.includeIneligible) {
    await createFeedTrack(user.id, {
      confidence: "0.700",
      feedState: "new",
      followed: true,
      matchRule: "metadata",
      providerTrackId: "0000000000000000000010",
      releaseDate: "2026-07-29",
      title: "Uncertain track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "dismissed",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000011",
      releaseDate: "2026-07-28",
      title: "Dismissed track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "new",
      followed: false,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000012",
      releaseDate: "2026-07-27",
      title: "Unfollowed track",
    });
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "needs_review",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId: "0000000000000000000013",
      releaseDate: "2026-07-26",
      title: "Review track",
    });
    await createDuplicateAppearance(user.id, exact);
  }
  return {
    confirmedProviderTrackId: confirmed.providerTrackId,
    exactArtistId: exact.artistId,
    exactProviderTrackId: exact.providerTrackId,
    exactReleaseId: exact.releaseId,
    thirdProviderTrackId,
    userId: user.id,
  };
}

async function createExactBatchFixture(trackCount: number) {
  const [user] = await db
    .insert(users)
    .values({ displayName: "Batch owner", email: "batch-owner@example.test" })
    .returning();
  if (!user) throw new Error("Batch test user was not created.");
  await db.insert(oauthAccounts).values({
    provider: "spotify",
    providerAccountId: "owner-account",
    providerUserId: "owner",
    scopes: [
      "user-follow-read",
      "playlist-read-private",
      "playlist-modify-private",
      "playlist-modify-public",
    ],
    userId: user.id,
  });
  const providerTrackIds: string[] = [];
  for (let index = 0; index < trackCount; index += 1) {
    const providerTrackId = String(index + 1).padStart(22, "0");
    providerTrackIds.push(providerTrackId);
    await createFeedTrack(user.id, {
      confidence: "1.000",
      feedState: "new",
      followed: true,
      matchRule: "exact_isrc",
      providerTrackId,
      releaseDate: `2026-08-${String(28 - index).padStart(2, "0")}`,
      title: `Batch track ${String(index + 1).padStart(2, "0")}`,
    });
  }
  return { providerTrackIds, userId: user.id };
}

async function createFeedTrack(
  userId: string,
  input: {
    confidence: string;
    feedState: FeedState;
    followed: boolean;
    matchRule: string;
    providerTrackId: string;
    releaseDate: string;
    title: string;
  },
) {
  const [artist] = await db
    .insert(artists)
    .values({ name: `${input.title} Artist`, normalizedName: input.title.toLowerCase() })
    .returning();
  const [release] = await db
    .insert(releases)
    .values({
      normalizedTitle: input.title.toLowerCase(),
      releaseDate: input.releaseDate,
      releaseDatePrecision: "day",
      releaseType: "single",
      title: `${input.title} Release`,
    })
    .returning();
  if (!artist || !release) throw new Error("Fixture identity was not created.");
  const [track] = await db
    .insert(tracks)
    .values({ normalizedTitle: input.title.toLowerCase(), title: input.title })
    .returning();
  if (!track) throw new Error("Fixture track was not created.");
  await db.insert(trackCredits).values({
    artistId: artist.id,
    creditOrder: 0,
    creditedName: artist.name,
    role: "primary",
    trackId: track.id,
  });
  if (input.followed) {
    await db.insert(artistFollows).values({ artistId: artist.id, userId });
  }
  const [appearance] = await db
    .insert(releaseTrackAppearances)
    .values({ discNumber: 1, releaseId: release.id, trackId: track.id, trackNumber: 1 })
    .returning();
  const [candidate] = await db
    .insert(releaseCandidates)
    .values({
      artistExternalId: `artist-${input.providerTrackId}`,
      firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
      matchConfidence: input.confidence,
      matchedTrackId: track.id,
      matchReasons: ["fixture"],
      matchRule: input.matchRule,
      matchStatus: input.feedState === "needs_review" ? "needs_review" : "matched",
      normalizedTitle: input.title.toLowerCase(),
      payloadHash: `hash-${input.providerTrackId}`,
      provider: "spotify",
      providerReleaseId: `release-${input.providerTrackId}`,
      providerTrackId: input.providerTrackId,
      rawPayload: {},
      releaseDate: input.releaseDate,
      title: input.title,
    })
    .returning();
  if (!appearance || !candidate) throw new Error("Fixture candidate was not created.");
  await db.insert(feedItems).values({
    appearanceId: appearance.id,
    candidateId: candidate.id,
    dedupeKey: `feed-${input.providerTrackId}`,
    dismissedAt: input.feedState === "dismissed" ? new Date() : null,
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    releaseId: release.id,
    state: input.feedState,
    trackId: track.id,
    userId,
  });
  return {
    artistId: artist.id,
    appearanceId: appearance.id,
    candidateId: candidate.id,
    providerTrackId: input.providerTrackId,
    releaseId: release.id,
    trackId: track.id,
  };
}

async function createDuplicateAppearance(
  userId: string,
  input: { candidateId: string; trackId: string },
) {
  const [release] = await db
    .insert(releases)
    .values({
      normalizedTitle: "duplicate appearance",
      releaseDate: "2026-07-01",
      releaseDatePrecision: "day",
      releaseType: "compilation",
      title: "Duplicate appearance",
    })
    .returning();
  if (!release) throw new Error("Duplicate release was not created.");
  const [appearance] = await db
    .insert(releaseTrackAppearances)
    .values({ discNumber: 1, releaseId: release.id, trackId: input.trackId, trackNumber: 1 })
    .returning();
  if (!appearance) throw new Error("Duplicate appearance was not created.");
  await db.insert(feedItems).values({
    appearanceId: appearance.id,
    candidateId: input.candidateId,
    dedupeKey: `duplicate-${input.trackId}`,
    firstSeenAt: new Date("2026-08-01T00:00:00.000Z"),
    releaseId: release.id,
    state: "new",
    trackId: input.trackId,
    userId,
  });
}

async function tableCount(
  table:
    | typeof playlistTargets
    | typeof providerCache
    | typeof playlistExports
    | typeof spotifyPlaylistExportRuns
    | typeof spotifyPlaylistExportOperations,
) {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
  return row?.count ?? 0;
}
