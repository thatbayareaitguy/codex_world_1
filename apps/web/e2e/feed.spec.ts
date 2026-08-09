import { expect, test } from "@playwright/test";
import { feedFixtures } from "@radar/testing";

test("opens the discovery feed on New and keeps All as the second tab", async ({ page }) => {
  await page.goto("/#feed");

  const tabs = page.getByRole("tablist", { name: "Feed state" }).getByRole("tab");
  await expect(tabs.nth(0)).toHaveText("New");
  await expect(tabs.nth(1)).toHaveText("All");
  await expect(page.getByRole("tab", { name: "New" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Juniper Vale - Afterimage" })).toHaveCount(0);

  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByRole("tab", { name: "All" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("article")).toHaveCount(4);
});

test("shows released previews individually without exposing their future album in New", async ({
  page,
}) => {
  const futureReleaseId = "71000000-0000-4000-8000-000000000001";
  const previews = [
    {
      ...feedFixtures[0]!,
      artist: "Future Artist",
      id: "71000000-0000-4000-8000-000000000002",
      releaseDate: "2026-07-31",
      releaseGroupDate: "2026-09-25",
      releaseId: futureReleaseId,
      releaseTitle: "Future Album",
      state: "new" as const,
      title: "Released Preview One",
    },
    {
      ...feedFixtures[1]!,
      artist: "Future Artist",
      id: "71000000-0000-4000-8000-000000000003",
      releaseDate: "2026-08-01",
      releaseGroupDate: "2026-09-25",
      releaseId: futureReleaseId,
      releaseTitle: "Future Album",
      state: "new" as const,
      title: "Released Preview Two",
    },
  ];
  await page.route("**/api/feed**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("mode") === "revision") {
      await route.fulfill({ json: { count: 2, revision: "future-preview" } });
      return;
    }
    await route.fulfill({
      json: {
        count: 2,
        hasMore: false,
        items: previews,
        nextCursor: null,
        revision: "future-preview",
        summary: { needsReview: 0, newThisWeek: 2, upcoming: 0 },
        totalCount: 2,
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(
    page.getByRole("heading", { name: "Future Artist - Released Preview One" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Future Artist - Released Preview Two" }),
  ).toBeVisible();
  await expect(
    page.locator(".release-feed-group-heading").filter({ hasText: "Future Album" }),
  ).toHaveCount(0);
});

test("shows externally persisted discoveries without reloading the page", async ({ page }) => {
  let revision = "revision-1";
  let revisionChecks = 0;
  let refreshFails = false;
  const externalItem = {
    accent: "lime",
    artist: "Lumen Field",
    confidence: 1,
    exportStatus: "eligible",
    firstSeenAt: "2026-07-19T19:00:00.000Z",
    id: "external-feed-item",
    links: [{ href: "https://example.test/evidence/glass-signal", label: "Source evidence" }],
    listened: false,
    matchReason: "Exact provider recording ID",
    region: "US",
    releaseDate: "2026-07-19",
    releaseDatePrecision: "day",
    releaseTitle: "Glass Signal",
    releaseType: "single",
    saved: false,
    soundcloudState: "NOT_CHECKED",
    sources: [
      {
        evidenceHref: "https://example.test/evidence/glass-signal",
        href: "https://example.test/releases/glass-signal",
        provider: "Spotify",
      },
    ],
    spotify: "playable",
    state: "new",
    title: "Glass Signal",
  } as const;

  await page.route("**/api/feed**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (refreshFails) {
      await route.fulfill({ json: { error: "Synthetic refresh failure" }, status: 500 });
      return;
    }
    if (requestUrl.searchParams.get("mode") === "revision") {
      revisionChecks += 1;
      await route.fulfill({ json: { count: revision === "revision-1" ? 4 : 5, revision } });
      return;
    }
    await route.fulfill({
      json: {
        count: revision === "revision-1" ? 4 : 5,
        items: revision === "revision-1" ? feedFixtures : [...feedFixtures, externalItem],
        revision,
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await expect.poll(() => revisionChecks).toBeGreaterThan(0);
  const glassHorizon = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Lumen Field - Glass Horizon" }),
  });
  await glassHorizon.getByRole("button", { name: "Collapse Glass Horizon" }).click();
  await page.getByRole("tab", { name: "New" }).click();
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Sort").selectOption("first-seen");
  const filteredFeedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === "/api/feed" &&
      url.searchParams.get("search") === "Glass" &&
      url.searchParams.get("mode") === null
    );
  });
  await page.getByRole("searchbox", { name: "Search discoveries" }).fill("Glass");
  await filteredFeedResponse;
  await page.evaluate(() => {
    Object.defineProperty(window, "feedRefreshMarker", { value: "still-here", writable: true });
  });

  revision = "revision-2";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(
    page.getByRole("status").filter({ hasText: "New or updated releases are available" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Signal" })).toHaveCount(0);
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Signal" })).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Feed refreshed from the top" }),
  ).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search discoveries" })).toHaveValue("Glass");
  await expect(page.getByRole("tab", { name: "New" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Sort")).toHaveValue("first-seen");
  await expect(glassHorizon.getByRole("button", { name: "Expand Glass Horizon" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "feedRefreshMarker") === "still-here"))
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Signal" })).toHaveCount(1);

  refreshFails = true;
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Feed refresh failed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Signal" })).toBeVisible();
});

test("loads another feed page and keeps unavailable evidence non-clickable", async ({ page }) => {
  const first = {
    ...feedFixtures[0]!,
    id: "70000000-0000-4000-8000-000000000001",
    links: [],
    sources: [],
    title: "First Paged Track",
  };
  const second = {
    ...feedFixtures[1]!,
    id: "70000000-0000-4000-8000-000000000002",
    title: "Second Paged Track",
  };
  await page.route("**/api/feed**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("mode") === "revision") {
      await route.fulfill({ json: { count: 2, revision: "paged-feed" } });
      return;
    }
    const older = url.searchParams.get("cursor") === "older-page";
    await route.fulfill({
      json: {
        count: 2,
        hasMore: !older,
        items: older ? [second] : [first],
        nextCursor: older ? null : "older-page",
        revision: "paged-feed",
        summary: { needsReview: 0, newThisWeek: 2, upcoming: 0 },
        totalCount: 2,
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.getByRole("heading", { name: /First Paged Track/ })).toBeVisible();
  await expect(page.getByText("Evidence unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Evidence" })).toHaveCount(0);
  const loadMore = page.getByRole("button", { name: "Load more discoveries" });
  await loadMore.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /Second Paged Track/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /First Paged Track/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Load more discoveries" })).toHaveCount(0);
});

test("resets feed pagination when filters and search change", async ({ page }) => {
  const feedRequests: string[] = [];
  await page.route("**/api/feed**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("mode") === "revision") {
      await route.fulfill({ json: { count: 1, revision: "filter-reset" } });
      return;
    }
    feedRequests.push(url.search);
    await route.fulfill({
      json: {
        count: 1,
        hasMore: true,
        items: [feedFixtures[0]],
        nextCursor: "older-page",
        revision: "filter-reset",
        summary: { needsReview: 0, newThisWeek: 1, upcoming: 0 },
        totalCount: 1,
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Release type").selectOption("single");
  await expect
    .poll(() =>
      feedRequests.some(
        (request) => request.includes("releaseType=single") && !request.includes("cursor="),
      ),
    )
    .toBe(true);
  await page.getByRole("searchbox", { name: "Search discoveries" }).fill("Glass");
  await expect
    .poll(() =>
      feedRequests.some(
        (request) => request.includes("search=Glass") && !request.includes("cursor="),
      ),
    )
    .toBe(true);
});

test("includes the artist in grouped release headings", async ({ page }) => {
  const groupedBase = feedFixtures[0]!;
  const groupedItems = [
    {
      ...groupedBase,
      artist: "Au5",
      id: "grouped-release-track-1",
      releaseDate: "2026-04-29",
      releaseGroupDate: "2099-09-25",
      releaseTitle: "Inverse",
      releaseType: "ep" as const,
      title: "Primordium",
      trackNumber: 2,
    },
    {
      ...groupedBase,
      artist: "Au5",
      id: "grouped-release-track-2",
      releaseDate: "2099-09-25",
      releaseGroupDate: "2099-09-25",
      releaseTitle: "Inverse",
      releaseType: "ep" as const,
      title: "Scission",
      trackNumber: 1,
    },
  ];

  await page.route("**/api/feed**", async (route) => {
    await route.fulfill({
      json: { count: groupedItems.length, items: groupedItems, revision: "grouped-release" },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("tab", { name: "All" }).click();
  await page.getByRole("button", { name: "Refresh feed" }).click();
  const group = page.getByRole("region", { name: "Au5 - Inverse Ep" });
  await expect(group.locator(".release-feed-group-title strong")).toHaveText("Au5 - Inverse");
  await expect(group.locator(".release-feed-group-title small")).toHaveText("Expected 09/25/2099");
  await expect(group.getByRole("article").getByRole("heading")).toHaveText([
    "Au5 - Scission",
    "Au5 - Primordium",
  ]);
  await group.getByRole("button", { name: "Collapse Au5 - Inverse Ep" }).click();
  await expect(group.getByRole("button", { name: "Expand Au5 - Inverse Ep" })).toBeVisible();
});

test("shows one canonical recording in each distinct release appearance", async ({ page }) => {
  const sharedRecording = feedFixtures[0]!;
  const appearances = [
    {
      ...sharedRecording,
      id: "single-appearance",
      releaseId: "single-release",
      releaseTitle: "Signal Single",
      releaseType: "single" as const,
      title: "Shared Signal",
    },
    {
      ...sharedRecording,
      id: "album-appearance",
      releaseId: "album-release",
      releaseTitle: "Signal Album",
      releaseType: "album" as const,
      title: "Shared Signal",
    },
  ];
  await page.route("**/api/feed**", async (route) => {
    await route.fulfill({
      json: { count: appearances.length, items: appearances, revision: "release-appearances" },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.getByRole("heading", { name: /Shared Signal/ })).toHaveCount(2);
  await expect(page.getByText("Signal Single", { exact: true })).toBeVisible();
  await expect(page.getByText("Signal Album", { exact: true })).toBeVisible();
});

test("keeps Spotify completeness metadata out of the discovery feed", async ({ page }) => {
  const base = feedFixtures[0]!;
  const items = [
    {
      ...base,
      id: "partial-album-item-1",
      releaseCompleteness: {
        expectedTracks: 25,
        fetchedTracks: 20,
        missingTracks: 5,
        status: "partial" as const,
      },
      releaseId: "partial-album",
      releaseTitle: "Partial Album",
      releaseType: "album" as const,
      title: "Partial Track One",
      trackNumber: 1,
    },
    {
      ...base,
      id: "partial-album-item-2",
      releaseCompleteness: {
        expectedTracks: 25,
        fetchedTracks: 20,
        missingTracks: 5,
        status: "partial" as const,
      },
      releaseId: "partial-album",
      releaseTitle: "Partial Album",
      releaseType: "album" as const,
      title: "Partial Track Two",
      trackNumber: 2,
    },
    {
      ...base,
      id: "complete-album-item-1",
      releaseCompleteness: {
        expectedTracks: 25,
        fetchedTracks: 25,
        missingTracks: 0,
        status: "completed" as const,
      },
      releaseId: "complete-album",
      releaseTitle: "Complete Album",
      releaseType: "album" as const,
      title: "Complete Track One",
      trackNumber: 1,
    },
    {
      ...base,
      id: "complete-album-item-2",
      releaseCompleteness: {
        expectedTracks: 25,
        fetchedTracks: 25,
        missingTracks: 0,
        status: "completed" as const,
      },
      releaseId: "complete-album",
      releaseTitle: "Complete Album",
      releaseType: "album" as const,
      title: "Complete Track Two",
      trackNumber: 2,
    },
    {
      ...base,
      id: "partial-single-item",
      releaseCompleteness: {
        expectedTracks: 1,
        fetchedTracks: 1,
        missingTracks: 0,
        status: "partial" as const,
      },
      releaseId: "partial-single",
      releaseTitle: "Standalone Single",
      releaseType: "single" as const,
      title: "Standalone Single",
    },
  ];
  await page.route("**/api/feed**", async (route) => {
    await route.fulfill({ json: { count: items.length, items, revision: "album-completeness" } });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.locator(".release-completeness")).toHaveCount(0);
  await expect(page.getByText("5 tracks missing", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Tracklist incomplete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Complete", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Partial album", { exact: true })).toHaveCount(0);
});

test("defaults scan history to the meaningful batch and inspects other run types", async ({
  page,
}) => {
  const batchRunId = "10000000-0000-4000-8000-000000000001";
  const singleRunId = "10000000-0000-4000-8000-000000000002";
  const dryRunId = "10000000-0000-4000-8000-000000000003";
  const cancelledRunId = "10000000-0000-4000-8000-000000000004";
  const pausedRunId = "10000000-0000-4000-8000-000000000005";
  const olderRunId = "10000000-0000-4000-8000-000000000006";
  const history = [
    {
      artistCount: 1,
      artistFilter: "20000000-0000-4000-8000-000000000001",
      batchId: "30000000-0000-4000-8000-000000000001",
      batchMode: "daily",
      completedAt: "2026-07-21T04:15:17.792Z",
      createdCount: 0,
      dryRun: false,
      failureCount: 0,
      id: singleRunId,
      partialArtistCount: 1,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: 1,
      reviewCount: 0,
      startedAt: "2026-07-21T04:15:17.400Z",
      status: "completed",
      triggerType: "provider_manual",
      updatedCount: 0,
    },
    {
      artistCount: 50,
      artistFilter: null,
      batchId: "30000000-0000-4000-8000-000000000002",
      batchMode: "daily",
      completedAt: "2026-07-21T04:13:51.904Z",
      createdCount: 90,
      dryRun: false,
      failureCount: 0,
      id: batchRunId,
      partialArtistCount: 50,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: 102,
      reviewCount: 1,
      startedAt: "2026-07-21T04:04:55.085Z",
      status: "completed",
      triggerType: "provider_manual",
      updatedCount: 0,
    },
    {
      artistCount: 1,
      artistFilter: "20000000-0000-4000-8000-000000000002",
      batchId: null,
      batchMode: null,
      completedAt: "2026-07-20T02:00:01.000Z",
      createdCount: 0,
      dryRun: true,
      failureCount: 1,
      id: dryRunId,
      partialArtistCount: null,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: null,
      reviewCount: 0,
      startedAt: "2026-07-20T02:00:00.000Z",
      status: "failed",
      triggerType: "manual",
      updatedCount: 0,
    },
    {
      artistCount: 5,
      artistFilter: null,
      batchId: "30000000-0000-4000-8000-000000000003",
      batchMode: "initial",
      completedAt: "2026-07-19T18:31:06.474Z",
      createdCount: 0,
      dryRun: false,
      failureCount: 0,
      id: cancelledRunId,
      partialArtistCount: 0,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: 3,
      reviewCount: 0,
      startedAt: "2026-07-19T18:30:31.476Z",
      status: "cancelled",
      triggerType: "provider_manual",
      updatedCount: 0,
    },
    {
      artistCount: 15,
      artistFilter: null,
      batchId: "30000000-0000-4000-8000-000000000004",
      batchMode: "initial",
      completedAt: null,
      createdCount: 0,
      dryRun: false,
      failureCount: 0,
      id: pausedRunId,
      partialArtistCount: 0,
      provider: "spotify",
      providersRequested: ["spotify"],
      requestCount: 4,
      reviewCount: 0,
      startedAt: "2026-07-18T20:00:00.000Z",
      status: "paused",
      triggerType: "provider_manual",
      updatedCount: 0,
    },
  ];

  await page.route("**/api/scans**", async (route) => {
    const olderPage = new URL(route.request().url()).searchParams.has("historyCursor");
    await route.fulfill({
      json: {
        active: null,
        defaultHistoryId: batchRunId,
        discoverySchedule: {
          catchup: {
            latest: {
              appleMusicBatchId: null,
              batchCompletedArtists: null,
              batchFailedArtists: null,
              batchTotalArtists: null,
              completedAt: null,
              errorClassification: null,
              jobType: "apple_catchup",
              recoveryDeadline: "2026-07-25T16:00:00.000Z",
              scheduledFor: "2026-07-24T16:00:00.000Z",
              status: "scheduled",
            },
            next: null,
          },
          full: {
            latest: {
              appleMusicBatchId: "77777777-7777-4777-8777-777777777777",
              batchCompletedArtists: 593,
              batchFailedArtists: 0,
              batchTotalArtists: 593,
              completedAt: "2026-07-24T06:00:00.000Z",
              errorClassification: null,
              jobType: "apple_full",
              recoveryDeadline: "2026-07-25T04:00:00.000Z",
              scheduledFor: "2026-07-24T04:00:00.000Z",
              status: "completed",
            },
            next: {
              appleMusicBatchId: null,
              batchCompletedArtists: null,
              batchFailedArtists: null,
              batchTotalArtists: null,
              completedAt: null,
              errorClassification: null,
              jobType: "apple_full",
              recoveryDeadline: "2026-08-01T04:00:00.000Z",
              scheduledFor: "2026-07-31T04:00:00.000Z",
              status: "scheduled",
            },
          },
          phase: "broad_spotify",
          playlistInbox: { exportRunId: null, pendingCount: 0, status: "completed" },
          timezone: "America/Los_Angeles",
        },
        history: olderPage
          ? [
              {
                ...history[2],
                id: olderRunId,
                startedAt: "2026-07-17T02:00:00.000Z",
                triggerType: "older_history_test",
              },
            ]
          : history,
        historyHasMore: !olderPage,
        historyNextCursor: olderPage ? null : "older-history-page",
        latest: null,
        running: false,
        runs: [],
        spotify: {
          batch: null,
          coverage: {
            currentCycleCompletedPages: 50,
            estimatedRemainingPages: 50,
            estimatedRemainingRequests: 50,
            failedArtists: 0,
            fullyReconciledArtists: 0,
            inProgressArtists: 0,
            partialArtists: 50,
            pausedArtists: 0,
            queuedArtists: 50,
            rateLimitedArtists: 0,
            totalArtists: 50,
          },
          limiter: {
            artistsPerBatch: 15,
            batchPauseSeconds: 60,
            distributionHours: 24,
            maxRequestsPerRun: 150,
            minRequestIntervalMs: 10000,
            reconciliationArtistsPerBatch: 15,
            reconciliationCycleDays: 30,
            reconciliationMaxPagesPerRun: 2,
          },
          operational: {
            canManualClear: false,
            cooldownActive: false,
            cooldownEndpointCategory: null,
            cooldownErrorClassification: null,
            cooldownIndefinite: false,
            cooldownObservedAt: null,
            cooldownUntil: null,
            lastRequestStartedAt: null,
            nextRequestAt: null,
            parsedRetryAfterSeconds: null,
            queueDepth: 0,
            rawRetryAfter: null,
            requestCount: 0,
          },
          scheduler: {
            activeLease: null,
            artistsCheckedLast24Hours: 101,
            artistsCheckedLastHour: 2,
            appleCatchupPriorityCount: 2,
            applePriorityCount: 4,
            backlog: {
              artist_reconciliation: 101,
              base_artist: 593,
              release_detail: 0,
              release_tracks: 0,
            },
            blockedCount: 0,
            blockedReasons: [],
            cooldownActive: false,
            cooldownUntil: null,
            dailyBudget: {
              broadArtistsLimit: 75,
              broadArtistsUsed: 12,
              broadRequestsLimit: 300,
              broadRequestsUsed: 48,
              localDate: "2026-07-24",
              playlistRequestReserve: 20,
              priorityRequestReserve: 200,
            },
            dueArtistCount: 102,
            eligibleArtistCount: 593,
            estimatedCompletion: {
              earliest: "2026-07-22T12:00:00.000Z",
              latest: "2026-07-23T12:00:00.000Z",
              state: "available",
            },
            endpointBudget: {
              artistAlbums: {
                allowance: 80,
                broadAllowance: 60,
                broadRemaining: 48,
                broadUsed: 12,
                calls: 16,
                nextCapacityAt: "2026-07-25T12:00:00.000Z",
                priorityRemaining: 64,
                priorityReserve: 20,
                priorityUsed: 4,
                remaining: 64,
                reserveRemaining: 16,
                reserveReleased: false,
              },
              playlist: { reads: 2, writes: 1 },
            },
            http429Last24Hours: 0,
            lastQuotaExceeded: null,
            mode: "disabled",
            nextBaseSlotAt: null,
            oldestOverdueAgeMs: 60000,
            overdueArtistCount: 10,
            partialArtistCount: 101,
            requestCounts: {
              byEndpointCategory: {
                album_detail: 0,
                album_tracks: 2,
                artist_albums: 16,
                oauth_or_other: 1,
                playlist_read: 2,
                playlist_write: 1,
              },
              byWorkType: { base_artist: 10, release_tracks: 2 },
              last24Hours: 12,
              last30Minutes: 1,
            },
            recentWork: null,
            targetArtistCount: 593,
          },
        },
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  const panel = page.getByRole("region", { name: "Scan history status" });
  const selector = panel.getByLabel("Inspect scan history");
  const metric = (label: string) =>
    panel
      .locator(".scan-history-grid > div")
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator("dd");

  await expect(selector).toHaveValue(batchRunId);
  await expect(panel.getByText("Spotify 50-artist batch", { exact: true })).toBeVisible();
  await expect(metric("Scan ID")).toHaveText(batchRunId);
  await expect(metric("Artists")).toHaveText("50");
  await expect(metric("Requests")).toHaveText("102");
  await expect(metric("Created records")).toHaveText("90");
  await expect(metric("Updated records")).toHaveText("0");
  await expect(metric("Partial artists")).toHaveText("50");
  await expect(metric("Failures")).toHaveText("0");
  await expect(metric("Dry run")).toHaveText("No");

  await selector.selectOption(singleRunId);
  await expect(panel.getByText("Spotify single-artist scan", { exact: true })).toBeVisible();
  await expect(metric("Artists")).toHaveText("1");
  await expect(metric("Requests")).toHaveText("1");

  await selector.selectOption(dryRunId);
  await expect(
    panel.getByText("Spotify single-artist scan | dry run", { exact: true }),
  ).toBeVisible();
  await expect(metric("Status")).toHaveText("Failed");
  await expect(metric("Requests")).toHaveText("Unavailable");
  await expect(metric("Partial artists")).toHaveText("Unavailable");
  await expect(metric("Failures")).toHaveText("1");
  await expect(metric("Dry run")).toHaveText("Yes");

  await expect(selector.locator("option")).toContainText([
    "single-artist scan",
    "50-artist batch",
    "dry run",
    "Cancelled",
    "Paused",
  ]);
  const appleSchedule = page.getByRole("region", {
    name: "Apple Music discovery schedule status",
  });
  await expect(appleSchedule).toContainText("Thursday full scan");
  await expect(appleSchedule).toContainText("Friday catch-up");
  await expect(appleSchedule).toContainText("593/593");
  await expect(appleSchedule).toContainText("Automatic playlist inbox");
  await expect(appleSchedule).toContainText("Export complete");
  const scheduler = page.getByRole("region", { name: "Spotify rolling scheduler status" });
  await expect(scheduler).toContainText("Disabled");
  await expect(scheduler).toContainText("Eligible artists");
  await expect(scheduler).toContainText("593");
  await expect(scheduler).toContainText("Broad artists today");
  await expect(scheduler).toContainText("12 / 75");
  await expect(scheduler).toContainText("Broad request budget");
  await expect(scheduler).toContainText("48 / 300");
  await expect(scheduler).toContainText("Friday catch-up priority");
  await expect(scheduler).toContainText("Artist Albums budget");
  await expect(scheduler).toContainText("16 / 80");
  await expect(scheduler).toContainText("16 / 20 remaining");
  await expect(scheduler).toContainText("2 reads / 1 writes");
  await scheduler
    .getByRole("button", { name: "Collapse Spotify rolling scheduler status" })
    .click();
  await expect(scheduler.getByText("Eligible artists")).toBeHidden();
  await scheduler.getByRole("button", { name: "Expand Spotify rolling scheduler status" }).focus();
  await page.keyboard.press("Enter");
  await expect(scheduler.getByText("Eligible artists")).toBeVisible();
  await panel.getByRole("button", { name: "Load older scans" }).click();
  await expect(selector.locator(`option[value="${olderRunId}"]`)).toHaveCount(1);
});

test("hides dormant MusicBrainz controls and does not request its review API", async ({ page }) => {
  let musicBrainzRequests = 0;
  await page.route("**/api/musicbrainz/**", async (route) => {
    musicBrainzRequests += 1;
    await route.fulfill({ json: { error: "unexpected request" }, status: 500 });
  });

  await page.goto("/#review");
  await expect(page.getByRole("option", { name: "MusicBrainz mappings" })).toHaveCount(0);
  await expect(page.getByText(/MusicBrainz configured|MusicBrainz not configured/)).toHaveCount(0);

  await page.goto("/#artists");
  await expect(page.getByRole("button", { name: /MusicBrainz mapping/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /MusicBrainz scan/ })).toHaveCount(0);

  await page.goto("/#settings");
  await expect(page.getByText("MusicBrainz", { exact: true })).toHaveCount(0);

  await page.goto("/#status");
  await expect(page.getByText("MusicBrainz", { exact: true })).toHaveCount(0);
  expect(musicBrainzRequests).toBe(0);
});

test("runs a mock scan, opens evidence, changes status, and filters the feed", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-19T12:00:00-07:00"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
  await page.getByRole("tab", { name: "All" }).click();
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.locator(".feed-item .state-new")).toHaveCount(0);
  await expect(page.getByText(/\d+% match/)).toHaveCount(0);
  const summaryMetrics = page.locator(".metrics > div");
  await expect(summaryMetrics.nth(0).locator("strong")).toHaveText("3");
  await expect(summaryMetrics.nth(0).locator("small")).toHaveText("+0 since last scan");
  await expect(summaryMetrics.nth(1).locator("strong")).toHaveText("1");

  const glassHorizon = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Lumen Field - Glass Horizon" }),
  });
  await expect(glassHorizon.locator(".item-heading > .artist")).toHaveCount(0);
  await expect(glassHorizon.locator(".item-title-date")).toHaveText("| Saturday, 7/11/26");
  await expect(glassHorizon.locator(".item-facts")).not.toContainText("Released");
  const alignedCardRows = await glassHorizon.evaluate((element) => {
    const heading = element.querySelector(".item-heading")?.getBoundingClientRect();
    const facts = element.querySelector(".item-facts")?.getBoundingClientRect();
    const evidence = element.querySelector(".evidence-row")?.getBoundingClientRect();
    return {
      evidenceAligned: Boolean(heading && evidence && Math.abs(heading.left - evidence.left) < 1),
      factsAligned: Boolean(heading && facts && Math.abs(heading.left - facts.left) < 1),
    };
  });
  expect(alignedCardRows).toEqual({ evidenceAligned: true, factsAligned: true });
  await expect(glassHorizon.locator(".badges").getByText("Spotify", { exact: true })).toBeVisible();
  const afterimage = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Juniper Vale - Afterimage" }),
  });
  await expect(afterimage.locator(".badges").getByText("Spotify", { exact: true })).toHaveCount(0);

  const lastScan = page.locator(".last-scan-metric");
  await expect(lastScan.getByText("Last scan", { exact: true })).toBeVisible();
  const scanButton = lastScan.getByRole("button", { name: "Run mock scan" });
  await expect(scanButton).toBeVisible();
  await scanButton.click();
  await expect(scanButton).toBeDisabled();
  await expect(page.getByRole("progressbar", { name: "Release update progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "North Arcade - Signal Fires" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(5);
  await expect(page.getByRole("progressbar", { name: "Release update progress" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Signal Fires was added");
  await expect(summaryMetrics.nth(0).locator("strong")).toHaveText("4");
  await expect(summaryMetrics.nth(0).locator("small")).toHaveText("+1 since last scan");

  const signalFires = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "North Arcade - Signal Fires" }),
  });
  const expandedHeight = await signalFires.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(expandedHeight).toBeLessThan(140);
  await expect(
    signalFires.locator(".evidence-row").getByRole("link", { name: "Evidence" }),
  ).toBeVisible();
  const collapseButton = signalFires.getByRole("button", { name: "Collapse Signal Fires" });
  await expect(collapseButton).toHaveAttribute("aria-expanded", "true");
  await collapseButton.click();
  const expandButton = signalFires.getByRole("button", { name: "Expand Signal Fires" });
  await expect(expandButton).toHaveAttribute("aria-expanded", "false");
  await expect(signalFires.getByRole("link", { name: "Evidence" })).toBeHidden();
  const collapsedHeight = await signalFires.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(collapsedHeight).toBeLessThan(60);
  expect(collapsedHeight).toBeLessThan(expandedHeight);
  await expandButton.focus();
  await page.keyboard.press("Enter");
  await expect(signalFires.getByRole("button", { name: "Collapse Signal Fires" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  const evidenceLink = signalFires.getByRole("link", { name: "Evidence" });
  await expect(evidenceLink).toHaveAttribute(
    "href",
    "https://example.test/mock/evidence/signal-fires",
  );
  await expect(evidenceLink).toHaveAttribute("rel", "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await evidenceLink.click();
  const evidencePage = await popupPromise;
  await evidencePage.close();

  const saveButton = signalFires.getByRole("button", { name: "Save Signal Fires" });
  await saveButton.click();
  await expect(signalFires.getByRole("button", { name: "Unsave Signal Fires" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const listenedButton = signalFires.getByRole("button", { name: "Mark Signal Fires listened" });
  await listenedButton.click();
  await expect(
    signalFires.getByRole("button", { name: "Mark Signal Fires unlistened" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(signalFires.getByText("Saved", { exact: true })).toBeVisible();
  await expect(signalFires.getByText("Listened", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { name: "North Arcade - Signal Fires" })).toBeVisible();
  await page.getByRole("tab", { name: "Listened" }).click();
  await expect(page.getByRole("heading", { name: "North Arcade - Signal Fires" })).toBeVisible();

  await page.getByRole("tab", { name: "All" }).click();
  await signalFires.getByRole("button", { name: "Unsave Signal Fires" }).click();
  await expect(signalFires.getByRole("button", { name: "Save Signal Fires" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(
    signalFires.getByRole("button", { name: "Mark Signal Fires unlistened" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { name: "North Arcade - Signal Fires" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Listened" }).click();
  await expect(page.getByRole("heading", { name: "North Arcade - Signal Fires" })).toBeVisible();

  await page.getByRole("tab", { name: "All" }).click();
  await signalFires.getByRole("button", { name: "Mark Signal Fires unlistened" }).click();
  await expect(
    signalFires.getByRole("button", { name: "Mark Signal Fires listened" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(signalFires.getByText("New", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Exact matches only").check();
  await expect(page.getByRole("heading", { name: "Oxide Echo - Static Bloom" })).toHaveCount(0);
  await page.getByLabel("Exact matches only").uncheck();
  await page.getByLabel("Spotify availability").selectOption("unavailable");
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Horizon" })).toHaveCount(0);
  await page.getByLabel("Spotify availability").selectOption("all");
  await page.getByLabel("Evidence source").selectOption("musicbrainz");
  await expect(page.getByRole("heading", { name: "Juniper Vale - Afterimage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Lumen Field - Glass Horizon" })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search discoveries" }).fill("No such release");
  await expect(page.getByText("No discoveries match this view.")).toBeVisible();
  await expect(summaryMetrics.nth(0).locator("strong")).toHaveText("4");
  await expect(summaryMetrics.nth(1).locator("strong")).toHaveText("1");
});

test("keeps every advanced filter inside the panel while resizing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Filters" }).click();
  const panel = page.locator(".filter-panel");
  await expect(panel).toBeVisible();

  for (const viewport of [
    { height: 900, width: 1400 },
    { height: 900, width: 900 },
    { height: 900, width: 480 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controlsFit = Array.from(element.querySelectorAll("input, select")).every((child) => {
        const childBounds = child.getBoundingClientRect();
        return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1;
      });
      return {
        controlsFit,
        noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
        withinViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
      };
    });
    expect(layout).toEqual({
      controlsFit: true,
      noHorizontalOverflow: true,
      withinViewport: true,
    });
  }
});

test("adds, sorts, edits, and removes a canonical artist", async ({ page }) => {
  await page.goto("/#artists");
  await expect(page.getByRole("heading", { name: "Followed artists" })).toBeVisible();

  const artistRows = page.locator(".data-row");
  const search = page.getByRole("searchbox", { name: "Search followed artists" });
  const sort = page.getByLabel("Sort artists");
  await search.fill("oxide");
  await expect(artistRows).toHaveCount(1);
  await expect(artistRows.first()).toContainText("Oxide Echo");
  await search.fill("missing artist");
  await expect(page.getByText("No artists match your search.")).toBeVisible();
  await search.fill("");
  await expect(artistRows).toHaveCount(4);
  await page.setViewportSize({ height: 900, width: 480 });
  const toolbarLayout = await page.locator(".artist-toolbar").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const controlsFit = Array.from(element.querySelectorAll("button, input, select")).every(
      (control) => {
        const controlBounds = control.getBoundingClientRect();
        return controlBounds.left >= bounds.left - 1 && controlBounds.right <= bounds.right + 1;
      },
    );
    return {
      controlsFit,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      withinViewport: bounds.left >= 0 && bounds.right <= window.innerWidth,
    };
  });
  expect(toolbarLayout).toEqual({
    controlsFit: true,
    noHorizontalOverflow: true,
    withinViewport: true,
  });
  await page.setViewportSize({ height: 900, width: 1280 });
  await sort.selectOption("name-desc");
  await expect(artistRows.first()).toContainText("Oxide Echo");
  await sort.selectOption("name-asc");
  await expect(artistRows.first()).toContainText("Juniper Vale");

  await page.getByRole("button", { name: "Add artist" }).click();
  await page.getByLabel("Artist name", { exact: true }).fill("Night Index");
  await page.getByRole("button", { name: "Add to watchlist" }).click();
  await expect(page.getByText("Night Index", { exact: true })).toBeVisible();
  await sort.selectOption("recent");
  await expect(artistRows.first()).toContainText("Night Index");

  await page.getByRole("button", { name: "Edit Night Index" }).click();
  await page.getByLabel("Artist name", { exact: true }).fill("Night Index Ensemble");
  await page.getByRole("button", { name: "Save artist" }).click();
  await expect(page.getByText("Night Index Ensemble", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Remove Night Index Ensemble" }).click();
  await expect(page.getByText("Night Index Ensemble", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("link", { name: "Followed artists 4" }),
  ).toBeVisible();
});

test("shows a confirmed Spotify import from the persisted watchlist response", async ({ page }) => {
  const importRunId = "00000000-0000-4000-8000-000000000101";
  const candidateId = "00000000-0000-4000-8000-000000000102";
  const artistId = "00000000-0000-4000-8000-000000000103";

  await page.route("**/api/spotify/status", async (route) => {
    await route.fulfill({
      json: {
        displayName: "Synthetic Spotify account",
        scopes: ["user-follow-read", "playlist-read-private"],
        state: "connected",
      },
    });
  });
  await page.route("**/api/spotify/import/preview", async (route) => {
    await route.fulfill({
      json: {
        candidates: [
          {
            id: candidateId,
            proposedAction: "create",
            providerName: "Regression Artist",
            providerUrl: "https://open.spotify.com/artist/synthetic-regression-artist",
            selected: true,
          },
        ],
        importRunId,
        retrieved: 1,
      },
    });
  });
  await page.route("**/api/spotify/import/confirm", async (route) => {
    await route.fulfill({
      json: {
        alreadyPresent: 0,
        created: 1,
        failed: 0,
        merged: 0,
        needsReview: 0,
        persisted: 1,
        retrieved: 1,
        selected: 1,
        skipped: 0,
      },
    });
  });
  await page.route("**/api/artists", async (route) => {
    await route.fulfill({
      json: {
        activeCount: 1,
        artists: [
          {
            active: true,
            addedAt: "2026-07-17T12:00:00.000Z",
            id: artistId,
            name: "Regression Artist",
            providers: ["spotify"],
            source: "spotify_import",
            spotifyCoverage: {
              catalogPagesCompleted: 1,
              dailyScanCompletedAt: "2026-07-17T12:10:00.000Z",
              lastFullReconciliationAt: null,
              nextOffset: 10,
              pagesScannedInCycle: 1,
              partial: true,
              status: "reconciliation_queued",
            },
          },
        ],
      },
    });
  });

  await page.goto("/#settings");
  await expect(page.getByText("Connected: Synthetic Spotify account")).toBeVisible();
  await page.getByRole("button", { name: "Import followed artists" }).click();
  await expect(page.getByText("Import preview: 1 followed artists")).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();

  await expect(page).toHaveURL(/#artists$/);
  await expect(page.getByRole("heading", { name: "Followed artists" })).toBeVisible();
  await expect(page.getByText("Regression Artist", { exact: true })).toBeVisible();
  await expect(page.getByText("Imported from Spotify", { exact: true })).toBeVisible();
  await expect(page.getByText("Partial catalog", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Spotify import persisted 1 active artists");
});

test("hides MusicBrainz mapping by default and preserves advanced mapping coverage", async ({
  page,
}) => {
  if (process.env.MUSICBRAINZ_ENABLED !== "true") {
    await page.goto("/#artists");
    await expect(page.getByRole("button", { name: /MusicBrainz mapping/ })).toHaveCount(0);
    return;
  }
  const importRunId = "00000000-0000-4000-8000-000000000111";
  const candidateId = "00000000-0000-4000-8000-000000000112";
  const artistId = "00000000-0000-4000-8000-000000000113";
  const firstMbid = "00000000-0000-4000-8000-000000000114";
  const replacementMbid = "00000000-0000-4000-8000-000000000115";
  const firstReviewId = "00000000-0000-4000-8000-000000000116";
  const replacementReviewId = "00000000-0000-4000-8000-000000000117";
  let confirmedMbid: string | null = null;
  let previewRequests = 0;
  const reviews = [
    { id: firstReviewId, proposedExternalId: firstMbid, status: "pending" },
    { id: replacementReviewId, proposedExternalId: replacementMbid, status: "pending" },
  ];

  await page.route("**/api/spotify/status", async (route) => {
    await route.fulfill({
      json: {
        displayName: "Synthetic Spotify account",
        scopes: ["user-follow-read", "playlist-read-private"],
        state: "connected",
      },
    });
  });
  await page.route("**/api/spotify/import/preview", async (route) => {
    await route.fulfill({
      json: {
        candidates: [
          {
            id: candidateId,
            proposedAction: "create",
            providerName: "Regression Artist",
            providerUrl: "https://open.spotify.com/artist/synthetic-regression-artist",
            selected: true,
          },
        ],
        importRunId,
        retrieved: 1,
      },
    });
  });
  await page.route("**/api/spotify/import/confirm", async (route) => {
    await route.fulfill({
      json: {
        alreadyPresent: 0,
        created: 1,
        failed: 0,
        merged: 0,
        needsReview: 0,
        persisted: 1,
        retrieved: 1,
        selected: 1,
        skipped: 0,
      },
    });
  });
  await page.route("**/api/artists", async (route) => {
    await route.fulfill({
      json: {
        activeCount: 1,
        artists: [
          {
            active: true,
            addedAt: "2026-07-17T12:00:00.000Z",
            id: artistId,
            name: "Regression Artist",
            providers: confirmedMbid ? ["spotify", "musicbrainz"] : ["spotify"],
            source: "spotify_import",
            spotifyCoverage: {
              catalogPagesCompleted: 3,
              dailyScanCompletedAt: "2026-07-17T12:10:00.000Z",
              lastFullReconciliationAt: "2026-07-17T12:20:00.000Z",
              nextOffset: 0,
              pagesScannedInCycle: 3,
              partial: false,
              status: "fully_reconciled",
            },
          },
        ],
      },
    });
  });
  await page.route("**/api/musicbrainz/mappings?*", async (route) => {
    await route.fulfill({
      json: {
        mappings: confirmedMbid
          ? [
              {
                artistId,
                artistName: "Regression Artist",
                confidence: "0.990",
                externalId: confirmedMbid,
                reasons: ["Synthetic exact mapping", "DnB"],
                url: `https://musicbrainz.org/artist/${confirmedMbid}`,
              },
            ]
          : [],
        reviews,
      },
    });
  });
  await page.route("**/api/musicbrainz/mappings/preview", async (route) => {
    previewRequests += 1;
    for (const review of reviews) {
      review.status = review.proposedExternalId === confirmedMbid ? "confirmed" : "pending";
    }
    await route.fulfill({
      json: {
        automatic: false,
        currentMapping: confirmedMbid,
        results: [
          {
            confidence: 0.99,
            disambiguation: "DnB",
            id: firstMbid,
            name: "Regression Artist",
            reasons: ["Synthetic exact mapping", "DnB"],
          },
          {
            confidence: 0.85,
            id: replacementMbid,
            name: "Regression Artist Two",
            reasons: ["Synthetic replacement mapping"],
          },
        ],
      },
    });
  });
  await page.route("**/api/musicbrainz/mappings/decision", async (route) => {
    const body = route.request().postDataJSON() as { reviewId: string };
    const selected = reviews.find((review) => review.id === body.reviewId)!;
    confirmedMbid = selected.proposedExternalId;
    for (const review of reviews) {
      review.status = review.id === selected.id ? "confirmed" : "rejected";
    }
    await route.fulfill({
      json: {
        artistId,
        decision: "confirm",
        externalId: confirmedMbid,
        idempotent: false,
      },
    });
  });

  const importArtist = async () => {
    await page.goto("/#settings");
    await page.getByRole("button", { name: "Import followed artists" }).click();
    await page.getByRole("button", { name: "Confirm import" }).click();
    await expect(page).toHaveURL(/#artists$/);
  };

  await importArtist();
  await expect(page.getByText("Fully reconciled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Map Regression Artist MusicBrainz mapping" }).click();
  await page.getByRole("button", { name: "Confirm mapping" }).first().click();
  const modal = page.getByRole("region", { name: "MusicBrainz mapping candidates" });
  await expect(modal.getByText("Confirmed mapping")).toBeVisible();
  await expect(modal).toContainText(`MBID: ${firstMbid}`);
  await expect(modal.getByText("Regression Artist Two")).toHaveCount(0);
  await modal.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "View Regression Artist MusicBrainz mapping" }).click();
  await expect(modal).toContainText(`MBID: ${firstMbid}`);
  expect(previewRequests).toBe(1);
  await modal.getByRole("button", { name: "Close" }).click();

  await page.reload();
  await importArtist();
  await page.getByRole("button", { name: "View Regression Artist MusicBrainz mapping" }).click();
  await expect(modal).toContainText(`MBID: ${firstMbid}`);
  expect(previewRequests).toBe(1);

  await modal.getByRole("button", { name: "Replace mapping" }).click();
  await expect(modal.getByText("Currently confirmed")).toBeVisible();
  await modal.getByRole("button", { name: "Confirm replacement" }).click();
  await expect(modal).toContainText(`MBID: ${replacementMbid}`);
  await expect(modal.getByText("Regression Artist", { exact: true })).toBeVisible();
  await expect(modal.getByText("Regression Artist Two")).toHaveCount(0);
  expect(previewRequests).toBe(2);
});

test("hides manual SoundCloud controls by default", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: "Primary navigation" });
  await expect(navigation.getByRole("link", { name: /SoundCloud links/ })).toHaveCount(0);
  await expect(page.getByText(/SoundCloud search/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /SoundCloud/ })).toHaveCount(0);
  await page.goto("/#soundcloud-links");
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
  await page.goto("/#artists");
  await expect(page.getByRole("heading", { name: "Followed artists" })).toBeVisible();
  await expect(page.getByRole("button", { name: /SoundCloud/ })).toHaveCount(0);
});

test("navigates every primary view and resolves manual review", async ({ page }) => {
  await page.route("**/api/musicbrainz/mappings", async (route) => {
    await route.fulfill({ json: { mappings: [], reviews: [] } });
  });
  await page.goto("/#exports");
  const navigation = page.getByRole("complementary", { name: "Primary navigation" });

  await expect(page.getByRole("heading", { name: "Playlist exports" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run live add-only export" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Inspect configured playlist" })).toBeEnabled();
  await expect(page.getByLabel("Existing private Spotify playlist")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create private playlist" })).toHaveCount(0);

  await navigation.getByRole("link", { name: "Followed artists 4" }).click();
  await expect(page.getByRole("heading", { name: "Followed artists" })).toBeVisible();

  await navigation.getByRole("link", { name: "Review queue 1" }).click();
  await expect(page.getByRole("heading", { name: "Review queue" })).toBeVisible();
  await expect(page.getByText(/90% confidence/)).toBeVisible();
  await page.getByRole("button", { name: "Confirm match" }).click();
  await expect(page.getByText("No items need review.")).toBeVisible();

  await navigation.getByRole("link", { name: "System status" }).click();
  await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
  await expect(page.getByText("External scheduler required", { exact: true })).toBeVisible();
  await expect(page.getByText("pnpm discovery:scheduler:tick", { exact: true })).toBeVisible();

  await navigation.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Spotify", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Manual SoundCloud links")).toBeVisible();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Spotify setup checklist")).toBeVisible();
  await expect(page.getByLabel("Currently granted Spotify scopes")).toBeVisible();
  await expect(page.getByLabel("Currently granted Spotify scopes")).toContainText(
    "user-follow-read",
  );
  await expect(
    page.getByText(
      "Spotify grants playlist permissions at the account scope level, not to one individual playlist. TS New Music Scanner additionally restricts itself to the configured playlist ID.",
    ),
  ).toBeVisible();
  await page.getByLabel("Discovery digest").check();

  await navigation.getByRole("link", { name: /^Discovery feed/ }).click();
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
});

test("previews and runs the configured add-only Spotify export", async ({ page }) => {
  const targetId = "4l6LaMPL6duulmFe3hRR4Y";
  let liveRequests = 0;

  await page.route("**/api/spotify/playlists", async (route) => {
    await route.fulfill({
      json: {
        allowedPlaylistConfigured: true,
        playlist: {
          collaborative: false,
          id: "4l6L...RR4Y",
          name: "Release Inbox",
          public: true,
        },
        writesEnabled: true,
      },
    });
  });
  await page.route("**/api/spotify/playlist-sync", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        json: {
          additions: [
            {
              position: 2,
              providerTrackId: "spotify-track-1",
              releaseDate: "2026-08-04",
              releaseTitle: "Exact Release",
              title: "Exact Track",
            },
          ],
          skipCounts: { ambiguous_match: 1, dismissed: 1 },
          target: {
            id: targetId,
            idAbbreviated: "4l6L...RR4Y",
            name: "Release Inbox",
            public: true,
          },
          totals: {
            additions: 1,
            alreadyPresent: 3,
            eligible: 4,
            orderingConflicts: 0,
            skipped: 2,
          },
        },
      });
      return;
    }

    liveRequests += 1;
    expect(route.request().postData()).toBeNull();
    await route.fulfill({
      json: {
        run: {
          additionsAttempted: 1,
          failed: 0,
          pending: 0,
          status: "completed",
        },
      },
    });
  });

  await page.goto("/#exports");
  await expect(page.getByText("Configured target 4l6L...RR4Y")).toBeVisible();

  await page.getByRole("button", { name: "Inspect configured playlist" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Owned, public, and non-collaborative" }),
  ).toContainText("Release Inbox");

  await page.getByRole("button", { name: "Preview sync" }).click();
  const preview = page.getByRole("status").filter({ hasText: "1 to add" });
  await expect(preview).toContainText(targetId);
  await expect(preview).toContainText("3 already present");
  await expect(preview).toContainText("1 ambiguous match");
  await expect(preview).toContainText("1 dismissed");

  await page.getByRole("button", { name: "Run live add-only export" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Spotify add-only export completed" }),
  ).toContainText("1 additions attempted, 0 failed, 0 pending");
  expect(liveRequests).toBe(1);
});

test("persists a manual review decision across feed refresh and page reload", async ({ page }) => {
  let decisionRequestCount = 0;
  let resolved = false;
  await page.route("**/api/musicbrainz/mappings", async (route) => {
    await route.fulfill({ json: { mappings: [], reviews: [] } });
  });
  await page.route("**/api/feed**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/feed-items/")) {
      decisionRequestCount += 1;
      resolved = true;
      expect(route.request().postDataJSON()).toEqual({ reviewDecision: "confirm" });
      await route.fulfill({
        json: {
          resolution: {
            decision: "confirm",
            feedItemId: "22222222-2222-4222-8222-222222222222",
            removed: true,
            state: "new",
          },
        },
      });
      return;
    }
    if (url.searchParams.get("mode") === "revision") {
      await route.fulfill({
        json: {
          count: resolved ? 3 : 4,
          revision: resolved ? "review-resolved" : "review-pending",
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        count: resolved ? 3 : 4,
        items: resolved ? [] : feedFixtures,
        revision: resolved ? "review-resolved" : "review-pending",
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#review");
  await expect(page.getByRole("heading", { name: "Static Bloom" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm match" }).click();
  await expect(page.getByText("No items need review.")).toBeVisible();
  expect(decisionRequestCount).toBe(1);

  await page.reload();
  await expect(page.getByText("No items need review.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Static Bloom" })).toHaveCount(0);
  expect(decisionRequestCount).toBe(1);
});

test("Keep separate retains the existing and newly separated discoveries", async ({ page }) => {
  let resolved = false;
  const review = {
    ...feedFixtures[1]!,
    id: "55555555-5555-4555-8555-555555555555",
  };
  const existing = {
    ...feedFixtures[1]!,
    id: "66666666-6666-4666-8666-666666666666",
    releaseTitle: "Static Bloom",
    state: "new" as const,
    title: "Static Bloom",
  };
  const separated = { ...review, state: "new" as const };
  await page.route("**/api/musicbrainz/mappings", async (route) => {
    await route.fulfill({ json: { mappings: [], reviews: [] } });
  });
  await page.route("**/api/feed**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/api/feed-items/")) {
      expect(route.request().postDataJSON()).toEqual({ reviewDecision: "separate" });
      resolved = true;
      await route.fulfill({
        json: {
          resolution: {
            decision: "separate",
            feedItemId: review.id,
            removed: false,
            state: "new",
          },
        },
      });
      return;
    }
    const items = resolved ? [existing, separated] : [existing, review];
    if (url.searchParams.get("mode") === "revision") {
      await route.fulfill({
        json: { count: items.length, revision: resolved ? "separate-resolved" : "separate-open" },
      });
      return;
    }
    await route.fulfill({
      json: {
        count: items.length,
        items,
        revision: resolved ? "separate-resolved" : "separate-open",
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#review");
  await page.getByRole("button", { name: "Keep separate" }).click();
  await expect(page.getByText("No items need review.")).toBeVisible();
  await page.getByRole("link", { name: /^Discovery feed/ }).click();
  await expect(
    page.getByRole("heading", { exact: true, name: "Oxide Echo - Static Bloom" }),
  ).toHaveCount(2);
  await expect(page.locator(".item-facts").getByText("Static Bloom", { exact: true })).toHaveCount(
    1,
  );
  await expect(
    page.locator(".item-facts").getByText("Static Bloom (session take)", { exact: true }),
  ).toHaveCount(1);
});

test("adds, pauses, enables, and removes a Reddit source without a Reddit request", async ({
  page,
}) => {
  let sources = [
    {
      enabled: true,
      id: "source-edm",
      lastError: null,
      lastSuccessfulScanAt: null,
      subreddit: "EDM",
    },
  ];
  await page.route("**/api/reddit/sources**", async (route) => {
    const request = route.request();
    const id = new URL(request.url()).pathname.split("/").at(-1);
    if (request.method() === "POST") {
      const body = request.postDataJSON() as { subreddit: string };
      sources = [
        ...sources,
        {
          enabled: true,
          id: "source-added",
          lastError: null,
          lastSuccessfulScanAt: null,
          subreddit: body.subreddit,
        },
      ];
      await route.fulfill({ json: { source: sources.at(-1) }, status: 201 });
      return;
    }
    if (request.method() === "PATCH") {
      const body = request.postDataJSON() as { enabled: boolean };
      sources = sources.map((source) =>
        source.id === id ? { ...source, enabled: body.enabled } : source,
      );
      await route.fulfill({ json: { source: sources.find((source) => source.id === id) } });
      return;
    }
    if (request.method() === "DELETE") {
      sources = sources.filter((source) => source.id !== id);
      await route.fulfill({ json: { removed: true } });
      return;
    }
    await route.fulfill({
      json: { approvalRecorded: false, enabled: false, sources },
    });
  });

  await page.goto("/#settings");
  await expect(page.getByText("Approval required, scanning disabled")).toBeVisible();
  await page.getByLabel("Add subreddit").fill("electronicmusic");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByText("r/electronicmusic")).toBeVisible();
  const added = page.locator(".reddit-source-row").filter({ hasText: "r/electronicmusic" });
  await added.getByRole("button", { name: "Pause" }).click();
  await expect(added.getByRole("button", { name: "Enable" })).toBeVisible();
  await added.getByRole("button", { name: "Enable" }).click();
  await added.getByRole("button", { name: "Remove r/electronicmusic" }).click();
  await expect(page.getByText("r/electronicmusic")).toHaveCount(0);
});

test("changes, persists, and follows the system appearance", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/#settings");

  const appearance = page.getByLabel("Appearance");
  const documentRoot = page.locator("html");
  await expect(appearance).toHaveValue("system");
  await expect(documentRoot).toHaveAttribute("data-theme", "light");
  await expect(page.locator(".theme-select-wrapper svg")).toHaveCSS("pointer-events", "none");

  await appearance.selectOption("dark");
  await expect(documentRoot).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ts-radar-theme"))).toBe("dark");

  await page.reload();
  await expect(appearance).toHaveValue("dark");
  await expect(documentRoot).toHaveAttribute("data-theme", "dark");

  await appearance.focus();
  await appearance.press("Home");
  await expect(appearance).toHaveValue("system");
  await expect(documentRoot).toHaveAttribute("data-theme", "light");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(documentRoot).toHaveAttribute("data-theme", "dark");

  await appearance.selectOption("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(documentRoot).toHaveAttribute("data-theme", "light");
});

test("controls persisted Spotify batches without bypassing cooldown state", async ({ page }) => {
  const batchId = "11111111-1111-4111-8111-111111111111";
  const artistScanId = "22222222-2222-4222-8222-222222222222";
  const runId = "44444444-4444-4444-8444-444444444444";
  const actions: string[] = [];
  let batchStatus = "running";
  let blockedMappingArtists = 0;
  let cooldownActive = false;
  const scanPayload = () => ({
    active:
      batchStatus === "running"
        ? {
            cancelRequested: false,
            completedUnits: 3,
            currentProvider: "spotify",
            currentUnit: "Synthetic Artist",
            expiresAt: "2026-07-17T22:00:00.000Z",
            heartbeatAt: "2026-07-17T21:00:00.000Z",
            phase: "scanning",
            providersCompleted: [],
            providersFailed: [],
            providersRequested: ["spotify"],
            rateLimitWaitMs: 0,
            requests: 4,
            retryAfterMs: 0,
            startedAt: "2026-07-17T20:00:00.000Z",
            totalUnits: 15,
          }
        : null,
    defaultHistoryId: runId,
    discoverySchedule: {
      catchup: { latest: null, next: null },
      full: { latest: null, next: null },
      phase: "broad_spotify",
      playlistInbox: { exportRunId: null, pendingCount: 0, status: "completed" },
      timezone: "America/Los_Angeles",
    },
    history: [
      {
        artistCount: 15,
        artistFilter: null,
        batchId,
        batchMode: "initial",
        completedAt:
          batchStatus === "running" || batchStatus === "paused" ? null : "2026-07-17T21:15:00.000Z",
        createdCount: 12,
        dryRun: false,
        failureCount: 0,
        id: runId,
        partialArtistCount: 0,
        provider: "spotify",
        providersRequested: ["spotify"],
        requestCount: 35,
        reviewCount: 1,
        startedAt: "2026-07-17T20:00:00.000Z",
        status: batchStatus === "blocked_mapping" ? "partial" : batchStatus,
        triggerType: "provider_manual",
        updatedCount: 0,
      },
    ],
    latest: null,
    running: batchStatus === "running",
    runs: [],
    spotify: {
      batch: {
        artistScans: [
          {
            artistId: "33333333-3333-4333-8333-333333333333",
            errorClassification: blockedMappingArtists ? "spotify_mapping_missing" : null,
            id: artistScanId,
            position: 0,
            status: blockedMappingArtists ? "blocked_mapping" : batchStatus,
          },
        ],
        blockedMappingArtists,
        cancelledArtists: 0,
        completedArtists: batchStatus === "completed" ? 15 : 3,
        confirmationRequired: batchStatus === "paused",
        estimatedRequests: 165,
        failedArtists: 0,
        id: batchId,
        mode: "initial",
        pageLimit: 2,
        partialArtists: 0,
        rateLimitedArtists: 0,
        status: batchStatus,
        totalArtists: 15,
      },
      coverage: {
        currentCycleCompletedPages: 50,
        estimatedRemainingPages: 50,
        estimatedRemainingRequests: 50,
        failedArtists: 0,
        fullyReconciledArtists: 0,
        inProgressArtists: 0,
        partialArtists: 50,
        pausedArtists: 0,
        queuedArtists: 50,
        rateLimitedArtists: 0,
        totalArtists: 50,
      },
      limiter: {
        artistsPerBatch: 15,
        batchPauseSeconds: 60,
        distributionHours: 24,
        maxRequestsPerRun: 150,
        minRequestIntervalMs: 10000,
        reconciliationArtistsPerBatch: 15,
        reconciliationCycleDays: 30,
        reconciliationMaxPagesPerRun: 2,
      },
      operational: {
        canManualClear: false,
        cooldownActive,
        cooldownEndpointCategory: cooldownActive ? "artist_albums" : null,
        cooldownErrorClassification: cooldownActive ? "rate_limited_integer_seconds" : null,
        cooldownIndefinite: false,
        cooldownObservedAt: cooldownActive ? "2026-07-17T21:00:00.000Z" : null,
        cooldownUntil: cooldownActive ? "2026-07-18T07:38:31.454Z" : null,
        lastRequestStartedAt: "2026-07-17T21:00:00.000Z",
        nextRequestAt: null,
        parsedRetryAfterSeconds: cooldownActive ? "47260" : null,
        queueDepth: 0,
        rawRetryAfter: null,
        requestCount: 4,
      },
    },
  });

  await page.route("**/api/scans", async (route) => {
    await route.fulfill({ contentType: "application/json", json: scanPayload() });
  });
  await page.route("**/api/spotify/scan-control", async (route) => {
    const body = route.request().postDataJSON() as { action: string };
    actions.push(body.action);
    await route.fulfill({ contentType: "application/json", json: { accepted: true }, status: 202 });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  const spotifyStatus = page.getByRole("region", { name: "Spotify scan status" });
  await expect(spotifyStatus).toContainText("Synthetic Artist");
  await expect(spotifyStatus).toContainText("Partial catalogs");
  await expect(spotifyStatus).toContainText("Awaiting reconciliation");
  const collapseStatus = spotifyStatus.getByRole("button", {
    name: "Collapse Spotify scan status",
  });
  await expect(collapseStatus).toHaveAttribute("aria-expanded", "true");
  await collapseStatus.click();
  await expect(spotifyStatus.getByText("Synthetic Artist")).toBeHidden();
  await expect(
    spotifyStatus.getByRole("button", { name: "Pause after current request" }),
  ).toBeHidden();
  const expandStatus = spotifyStatus.getByRole("button", { name: "Expand Spotify scan status" });
  await expect(expandStatus).toHaveAttribute("aria-expanded", "false");
  await expandStatus.focus();
  await page.keyboard.press("Enter");
  await expect(spotifyStatus.getByText("Synthetic Artist")).toBeVisible();
  await page.getByRole("button", { name: "Pause after current request" }).click();
  await page.getByRole("button", { name: "Cancel future work" }).click();
  expect(actions).toEqual(["pause", "cancel"]);

  batchStatus = "paused";
  cooldownActive = true;
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume" })).toBeDisabled();
  const musicBrainzOnlyUpdate = page.locator(".last-scan-metric").getByRole("button");
  await expect(musicBrainzOnlyUpdate).toBeDisabled();
  await expect(musicBrainzOnlyUpdate).toHaveAttribute(
    "title",
    "Provider scan disabled during Spotify cooldown",
  );

  batchStatus = "completed";
  cooldownActive = false;
  await page.reload();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Deep reconciliation" }).click();
  expect(actions).toContain("start_reconciliation");

  blockedMappingArtists = 1;
  batchStatus = "blocked_mapping";
  await page.reload();
  await expect(spotifyStatus.locator(".spotify-scan-grid")).toContainText("Blocked mapping");
  await expect(spotifyStatus.locator(".spotify-scan-grid")).toContainText("1");
  await expect(page.getByRole("button", { name: "Retry one artist" })).toBeVisible();
});
