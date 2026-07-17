import { expect, test } from "@playwright/test";

test("runs a mock scan, opens evidence, changes status, and filters the feed", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Discovery feed" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(4);

  const lastScan = page.locator(".last-scan-metric");
  await expect(lastScan.getByText("Last scan", { exact: true })).toBeVisible();
  const scanButton = lastScan.getByRole("button", { name: "Run mock scan" });
  await expect(scanButton).toBeVisible();
  await scanButton.click();
  await expect(scanButton).toBeDisabled();
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(5);
  await expect(page.getByRole("status")).toContainText("Signal Fires was added");

  const signalFires = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "Signal Fires" }),
  });
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

  await signalFires.getByRole("button", { name: "Save Signal Fires" }).click();
  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { name: "Signal Fires" })).toBeVisible();

  await page.getByRole("tab", { name: "All" }).click();
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Exact matches only").check();
  await expect(page.getByRole("heading", { name: "Static Bloom" })).toHaveCount(0);
  await page.getByLabel("Exact matches only").uncheck();
  await page.getByLabel("Spotify").selectOption("unavailable");
  await expect(page.getByRole("heading", { name: "Glass Horizon" })).toHaveCount(0);

  await page.getByRole("searchbox", { name: "Search discoveries" }).fill("No such release");
  await expect(page.getByText("No discoveries match this view.")).toBeVisible();
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
