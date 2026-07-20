import { expect, test } from "@playwright/test";

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
        items: revision === "revision-1" ? [] : [externalItem],
        revision,
      },
    });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await expect.poll(() => revisionChecks).toBeGreaterThan(0);
  const glassHorizon = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Glass Horizon" }),
  });
  await glassHorizon.getByRole("button", { name: "Collapse Glass Horizon" }).click();
  await page.getByRole("tab", { name: "New" }).click();
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Sort").selectOption("first-seen");
  await page.getByRole("searchbox", { name: "Search discoveries" }).fill("Glass");
  await page.evaluate(() => {
    Object.defineProperty(window, "feedRefreshMarker", { value: "still-here", writable: true });
  });

  revision = "revision-2";
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await expect(page.getByRole("heading", { name: "Glass Signal" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "1 new release added." })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search discoveries" })).toHaveValue("Glass");
  await expect(page.getByRole("tab", { name: "New" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Sort")).toHaveValue("first-seen");
  await expect(glassHorizon.getByRole("button", { name: "Expand Glass Horizon" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "feedRefreshMarker") === "still-here"))
    .toBe(true);
  await expect(page.getByRole("heading", { name: "Glass Signal" })).toHaveCount(1);

  refreshFails = true;
  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Feed refresh failed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Glass Signal" })).toBeVisible();
});

test("runs a mock scan, opens evidence, changes status, and filters the feed", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-07-19T12:00:00-07:00"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(page.locator(".feed-item .state-new")).toHaveCount(0);
  await expect(page.getByText(/\d+% match/)).toHaveCount(0);
  const summaryMetrics = page.locator(".metrics > div");
  await expect(summaryMetrics.nth(0).locator("strong")).toHaveText("3");
  await expect(summaryMetrics.nth(0).locator("small")).toHaveText("+0 since last scan");
  await expect(summaryMetrics.nth(1).locator("strong")).toHaveText("1");

  const glassHorizon = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Glass Horizon" }),
  });
  await expect(glassHorizon.locator(".badges").getByText("Spotify", { exact: true })).toBeVisible();
  const afterimage = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Afterimage" }),
  });
  await expect(afterimage.locator(".badges").getByText("Spotify", { exact: true })).toHaveCount(0);

  const lastScan = page.locator(".last-scan-metric");
  await expect(lastScan.getByText("Last scan", { exact: true })).toBeVisible();
  const scanButton = lastScan.getByRole("button", { name: "Run mock scan" });
  await expect(scanButton).toBeVisible();
  await scanButton.click();
  await expect(scanButton).toBeDisabled();
  await expect(page.getByRole("progressbar", { name: "Release update progress" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(5);
  await expect(page.getByRole("progressbar", { name: "Release update progress" })).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("Signal Fires was added");
  await expect(summaryMetrics.nth(0).locator("strong")).toHaveText("4");
  await expect(summaryMetrics.nth(0).locator("small")).toHaveText("+1 since last scan");

  const signalFires = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Signal Fires" }),
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
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();
  await page.getByRole("tab", { name: "Listened" }).click();
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();

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
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Listened" }).click();
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();

  await page.getByRole("tab", { name: "All" }).click();
  await signalFires.getByRole("button", { name: "Mark Signal Fires unlistened" }).click();
  await expect(
    signalFires.getByRole("button", { name: "Mark Signal Fires listened" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(signalFires.getByText("New", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Exact matches only").check();
  await expect(page.getByRole("heading", { name: "Static Bloom" })).toHaveCount(0);
  await page.getByLabel("Exact matches only").uncheck();
  await page.getByLabel("Spotify availability").selectOption("unavailable");
  await expect(page.getByRole("heading", { name: "Glass Horizon" })).toHaveCount(0);
  await page.getByLabel("Spotify availability").selectOption("all");
  await page.getByLabel("Evidence source").selectOption("musicbrainz");
  await expect(page.getByRole("heading", { name: "Afterimage" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Glass Horizon" })).toHaveCount(0);

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
  await expect(page.getByRole("status")).toContainText("Spotify import persisted 1 active artists");
});

test("persists and displays a confirmed MusicBrainz mapping before replacement", async ({
  page,
}) => {
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
  await expect(page.getByRole("button", { name: "Playlist writes disabled" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Inspect configured playlist" })).toBeDisabled();
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
  await expect(page.getByText("pnpm scan", { exact: true })).toBeVisible();

  await navigation.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("Spotify", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Manual SoundCloud links")).toBeVisible();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
  await expect(page.getByText("Spotify setup checklist")).toBeVisible();
  await expect(page.getByLabel("Currently granted Spotify scopes")).toBeVisible();
  await expect(page.getByLabel("Currently granted Spotify scopes")).not.toContainText(
    "playlist-modify",
  );
  await expect(
    page.getByText(
      "Spotify grants playlist permissions at the account scope level, not to one individual playlist. Release Inbox additionally restricts itself to the configured playlist ID.",
    ),
  ).toBeVisible();
  await page.getByLabel("Discovery digest").check();

  await navigation.getByRole("link", { name: "Discovery feed 4" }).click();
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
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
  const actions: string[] = [];
  let batchStatus = "running";
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
    latest: null,
    running: batchStatus === "running",
    runs: [],
    spotify: {
      batch: {
        artistScans: [
          {
            artistId: "33333333-3333-4333-8333-333333333333",
            errorClassification: null,
            id: artistScanId,
            position: 0,
            status: batchStatus,
          },
        ],
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
      limiter: {
        artistsPerBatch: 15,
        batchPauseSeconds: 60,
        distributionHours: 24,
        minRequestIntervalMs: 5000,
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
  await expect(musicBrainzOnlyUpdate).toBeEnabled();
  await expect(musicBrainzOnlyUpdate).toHaveAttribute(
    "title",
    "Run MusicBrainz-only update while Spotify is cooling down",
  );

  batchStatus = "completed";
  cooldownActive = false;
  await page.reload();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Deep reconciliation" }).click();
  expect(actions).toContain("start_reconciliation");
});
