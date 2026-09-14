import type {
  SpotifyReleaseReconciliationTarget,
  SpotifyReleaseTrackProgressStatus,
} from "@radar/db";
import {
  SpotifyHttpError,
  type SpotifyAlbumTracksPage,
  type SpotifyTrackSummary,
} from "@radar/providers";
import { describe, expect, it, vi } from "vitest";
import {
  runSpotifyReleaseReconciliation,
  type SpotifyReleaseReconciliationRepository,
  type SpotifyReleaseTrackClient,
} from "./spotify-release-reconciliation";

describe("release-only Spotify reconciliation", () => {
  it("uses explicit page limits and completes a real multi-page shape", async () => {
    const target = makeTarget({ expectedTotalTracks: 23 });
    const repository = statefulRepository([target]);
    const client = pageClient(23);

    const summary = await runSpotifyReleaseReconciliation(
      { maxPagesPerRelease: 10, pageSize: 10, releaseIds: [target.releaseId] },
      { client, repository },
    );

    expect(vi.mocked(client.getAlbumTracksPage)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(client.getAlbumTracksPage)).toHaveBeenNthCalledWith(
      1,
      target.spotifyAlbumId,
      0,
      undefined,
      10,
    );
    expect(vi.mocked(client.getAlbumTracksPage)).toHaveBeenNthCalledWith(
      2,
      target.spotifyAlbumId,
      10,
      undefined,
      10,
    );
    expect(vi.mocked(client.getAlbumTracksPage)).toHaveBeenNthCalledWith(
      3,
      target.spotifyAlbumId,
      20,
      undefined,
      10,
    );
    expect(summary.releases[0]).toMatchObject({
      finalFetchedTrackCount: 23,
      finalNextOffset: null,
      finalStatus: "completed",
      requestCount: 3,
    });
    expect(summary.releases[0]?.pages.map((page) => page.itemCount)).toEqual([10, 10, 3]);
  });

  it("persists one page, resumes at the retained offset, and skips after completion", async () => {
    const target = makeTarget({ expectedTotalTracks: 23 });
    const repository = statefulRepository([target]);
    const firstClient = pageClient(23);

    const first = await runSpotifyReleaseReconciliation(
      { maxPagesPerRelease: 1, pageSize: 10, releaseIds: [target.releaseId] },
      { client: firstClient, repository },
    );
    expect(first.releases[0]).toMatchObject({
      finalFetchedTrackCount: 10,
      finalNextOffset: 10,
      finalStatus: "partial",
    });

    const resumedClient = pageClient(23);
    const resumed = await runSpotifyReleaseReconciliation(
      { maxPagesPerRelease: 10, pageSize: 10, releaseIds: [target.releaseId] },
      { client: resumedClient, repository },
    );
    expect(vi.mocked(resumedClient.getAlbumTracksPage)).toHaveBeenNthCalledWith(
      1,
      target.spotifyAlbumId,
      10,
      undefined,
      10,
    );
    expect(resumed.releases[0]).toMatchObject({
      finalFetchedTrackCount: 23,
      finalStatus: "completed",
      startingOffset: 10,
    });

    const rerunClient = pageClient(23);
    const rerun = await runSpotifyReleaseReconciliation(
      { maxPagesPerRelease: 10, pageSize: 10, releaseIds: [target.releaseId] },
      { client: rerunClient, repository },
    );
    expect(vi.mocked(rerunClient.getAlbumTracksPage)).not.toHaveBeenCalled();
    expect(rerun.releases[0]).toMatchObject({ finalStatus: "completed", skipped: true });
  });

  it("rejects a missing allowlisted release before any provider request", async () => {
    const client = pageClient(1);
    await expect(
      runSpotifyReleaseReconciliation(
        { maxPagesPerRelease: 1, pageSize: 10, releaseIds: [crypto.randomUUID()] },
        { client, repository: statefulRepository([]) },
      ),
    ).rejects.toThrow("target validation failed");
    expect(vi.mocked(client.getAlbumTracksPage)).not.toHaveBeenCalled();
  });

  it("stops the allowlist immediately after a Spotify 429", async () => {
    const first = makeTarget({ title: "First" });
    const second = makeTarget({ title: "Second" });
    const repository = statefulRepository([first, second]);
    const getAlbumTracksPage = vi.fn().mockRejectedValue(new SpotifyHttpError("limited", 429));
    const client: SpotifyReleaseTrackClient = {
      getAlbumTracksPage,
      metrics: { failures: 1, queueWaitMs: 0, rateLimitWaitMs: 0, requests: 1 },
    };

    await expect(
      runSpotifyReleaseReconciliation(
        { maxPagesPerRelease: 1, pageSize: 10, releaseIds: [first.releaseId, second.releaseId] },
        { client, repository },
      ),
    ).rejects.toMatchObject({ status: 429 });
    expect(getAlbumTracksPage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repository.markInterrupted)).toHaveBeenCalledWith(
      expect.objectContaining({ spotifyAlbumId: first.spotifyAlbumId, status: "rate_limited" }),
    );
  });
});

function makeTarget(
  overrides: Partial<SpotifyReleaseReconciliationTarget> = {},
): SpotifyReleaseReconciliationTarget {
  return {
    expectedTotalTracks: 1,
    fetchedTrackCount: 0,
    nextOffset: 0,
    reconciliationCycleId: null,
    releaseId: crypto.randomUUID(),
    releaseType: "album",
    spotifyAlbumId: crypto.randomUUID().replaceAll("-", "").slice(0, 22),
    startedAt: null,
    status: "partial",
    title: "Synthetic release",
    ...overrides,
  };
}

function pageClient(total: number): SpotifyReleaseTrackClient {
  const metrics = { failures: 0, queueWaitMs: 0, rateLimitWaitMs: 0, requests: 0 };
  const getAlbumTracksPage = vi.fn<SpotifyReleaseTrackClient["getAlbumTracksPage"]>(
    (_id: string, offset: number, _signal?: AbortSignal, limit = 50) => {
      metrics.requests += 1;
      const count = Math.min(limit, total - offset);
      const nextOffset = offset + count;
      return Promise.resolve({
        items: Array.from({ length: count }, (_, index) => track(offset + index + 1)),
        next:
          nextOffset < total
            ? `https://api.spotify.com/v1/albums/album/tracks?limit=${limit}&offset=${nextOffset}`
            : null,
        offset,
        total,
      } satisfies SpotifyAlbumTracksPage);
    },
  );
  return { getAlbumTracksPage, metrics };
}

function track(position: number): SpotifyTrackSummary {
  return {
    artists: [
      {
        external_urls: { spotify: "https://open.spotify.com/artist/synthetic" },
        id: "synthetic",
        name: "Synthetic",
        type: "artist",
        uri: "spotify:artist:synthetic",
      },
    ],
    disc_number: position > 20 ? 2 : 1,
    duration_ms: 180_000,
    explicit: false,
    external_urls: { spotify: `https://open.spotify.com/track/track-${position}` },
    id: `track-${position}`,
    is_local: false,
    name: `Track ${position}`,
    track_number: position > 20 ? position - 20 : position,
    type: "track",
    uri: `spotify:track:track-${position}`,
  };
}

function statefulRepository(
  initialTargets: SpotifyReleaseReconciliationTarget[],
): SpotifyReleaseReconciliationRepository {
  const targets = new Map(initialTargets.map((target) => [target.releaseId, { ...target }]));
  const observed = new Map<string, Set<string>>();
  const markInterrupted = vi.fn<SpotifyReleaseReconciliationRepository["markInterrupted"]>(
    (input) => {
      const target = [...targets.values()].find(
        (candidate) => candidate.spotifyAlbumId === input.spotifyAlbumId,
      );
      if (target) target.status = input.status;
      return Promise.resolve();
    },
  );
  return {
    listTargets: (releaseIds) =>
      Promise.resolve(
        releaseIds.flatMap((releaseId) => {
          const target = targets.get(releaseId);
          return target ? [{ ...target }] : [];
        }),
      ),
    markInterrupted,
    recordPage: (input) => {
      const target = [...targets.values()].find(
        (candidate) => candidate.spotifyAlbumId === input.spotifyAlbumId,
      )!;
      const ids = observed.get(input.spotifyAlbumId) ?? new Set<string>();
      input.items.forEach((item) => ids.add(item.providerTrackId));
      observed.set(input.spotifyAlbumId, ids);
      const status: SpotifyReleaseTrackProgressStatus =
        input.terminal && ids.size === input.expectedTotalTracks ? "completed" : "partial";
      target.expectedTotalTracks = input.expectedTotalTracks;
      target.fetchedTrackCount = ids.size;
      target.nextOffset = status === "completed" ? null : input.nextOffset;
      target.status = status;
      return Promise.resolve({ fetchedTrackCount: ids.size, status });
    },
    start: (input) => {
      const target = [...targets.values()].find(
        (candidate) => candidate.spotifyAlbumId === input.spotifyAlbumId,
      )!;
      if (target.reconciliationCycleId !== input.reconciliationCycleId) {
        observed.set(input.spotifyAlbumId, new Set());
        target.fetchedTrackCount = 0;
        target.nextOffset = 0;
      }
      target.reconciliationCycleId = input.reconciliationCycleId ?? null;
      target.status = "in_progress";
      return Promise.resolve();
    },
    validateMappings: () =>
      Promise.resolve({
        missingAppearanceTrackIds: [],
        missingCanonicalTrackIds: [],
      }),
  };
}
