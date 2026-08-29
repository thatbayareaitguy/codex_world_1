import { expect, test } from "@playwright/test";
import generatedCatalog from "../lib/generated-public-catalog.json";

test("homepage introduces release and artist discovery", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Find your next favorite sound/i })).toBeVisible();
  await expect(
    page.getByRole("img", {
      name: /Showcase headphones logo glowing in orange, pink, violet, and blue/i,
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Explore new releases/i })).toHaveAttribute(
    "href",
    "/releases",
  );
  await expect(page.getByRole("heading", { name: "New this week" })).toBeVisible();
  await expect(page.getByText("ARTIST INDEX", { exact: true })).toBeVisible();
});

test("release filters and detail routes work", async ({ page }) => {
  const upcomingReleases = generatedCatalog.releases.filter(
    (release) => release.status === "upcoming",
  );
  const upcomingRelease = upcomingReleases[0];
  expect(upcomingRelease).toBeDefined();
  await page.goto("/releases");

  await expect(page.getByRole("heading", { name: /What is landing right now/i })).toBeVisible();
  const genreSelect = page.getByRole("combobox", { name: "Filter by genre" });
  const optionColors = await genreSelect
    .locator("option")
    .nth(1)
    .evaluate((option) => {
      const style = window.getComputedStyle(option);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
  expect(optionColors).toEqual({
    backgroundColor: "rgb(16, 13, 20)",
    color: "rgb(247, 245, 251)",
  });
  await page.getByRole("button", { name: "Upcoming" }).click();
  await expect(
    page.getByText(
      `${upcomingReleases.length} ${upcomingReleases.length === 1 ? "release" : "releases"}`,
      { exact: true },
    ),
  ).toBeVisible();
  const releaseCard = page
    .locator(".release-card")
    .filter({ hasText: upcomingRelease!.title })
    .first();
  await expect(releaseCard.getByRole("heading", { name: upcomingRelease!.title })).toBeVisible();
  await releaseCard.locator(".release-card-copy").click();
  await expect(page).toHaveURL(new RegExp(`/releases/${upcomingRelease!.slug}$`));
  await expect(page.getByRole("heading", { name: upcomingRelease!.title, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open in Apple Music" })).toHaveAttribute(
    "target",
    "_blank",
  );
});

test("release artwork uses Apple links and unmatched releases retain placeholders", async ({
  page,
}) => {
  const withArtwork = generatedCatalog.releases.find((release) => release.artwork !== undefined);
  const withoutArtwork = generatedCatalog.releases.find((release) => release.artwork === undefined);
  expect(withArtwork).toBeDefined();
  expect(withoutArtwork).toBeDefined();

  await page.goto(`/releases/${withArtwork!.slug}`);
  const artworkLink = page.getByRole("link", {
    name: `Open ${withArtwork!.title} on Apple Music`,
  });
  await expect(artworkLink).toHaveAttribute("href", withArtwork!.links.appleMusic);
  await expect(artworkLink).toHaveAttribute("target", "_blank");
  await expect(artworkLink.locator("img")).toHaveAttribute("src", withArtwork!.artwork.url);
  await expect(page.getByRole("link", { name: "Artwork via Apple Music" })).toHaveAttribute(
    "href",
    withArtwork!.links.appleMusic,
  );

  await page.goto(`/releases/${withoutArtwork!.slug}`);
  await expect(
    page.getByRole("img", { name: `Placeholder artwork for ${withoutArtwork!.title}` }),
  ).toBeVisible();
  await expect(page.locator(".release-detail-hero .apple-artwork-image")).toHaveCount(0);
});

test("artist filtering and structured profile work", async ({ page }) => {
  const artist = generatedCatalog.artists.find((item) => item.genreSlugs.length > 0);
  expect(artist).toBeDefined();
  await page.goto("/artists");

  await expect(
    page.getByText(
      "Explore the electronic artists we are following through the releases they make, the scenes they move through, and the genres they love.",
    ),
  ).toBeVisible();
  const genreSelect = page.getByRole("combobox", { name: "Filter artists by genre" });
  await genreSelect.selectOption({ index: 1 });
  await expect(page.locator(".artist-card").first()).toBeVisible();

  await page.getByPlaceholder("Search").fill(artist!.name);
  await genreSelect.selectOption("all");
  const artistCard = page.locator(".artist-card").filter({ hasText: artist!.name }).first();
  await expect(artistCard.getByRole("heading", { name: artist!.name })).toBeVisible();
  await artistCard.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/artists/${artist!.slug}$`));
  await expect(page.getByRole("heading", { name: artist!.name, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Apple Music/i })).toHaveAttribute(
    "target",
    "_blank",
  );
});

test("collaboration credits link to artists and trackless releases stay visible when present", async ({
  page,
}) => {
  const collaboration = generatedCatalog.releases.find(
    (release) =>
      release.artistCredits.filter((credit) => credit.artistSlug !== undefined).length > 1,
  );
  const trackless = generatedCatalog.releases.find((release) => release.tracks.length === 0);
  expect(collaboration).toBeDefined();

  await page.goto(`/releases/${collaboration!.slug}`);
  for (const credit of collaboration!.artistCredits) {
    if (credit.artistSlug === undefined) continue;
    await expect(page.getByRole("link", { name: credit.name, exact: true })).toHaveAttribute(
      "href",
      `/artists/${credit.artistSlug}`,
    );
  }

  if (trackless !== undefined) {
    await page.goto(`/releases/${trackless.slug}`);
    await expect(page.getByRole("heading", { name: trackless.title, level: 1 })).toBeVisible();
    await expect(page.getByText("TRACK LIST", { exact: true })).toHaveCount(0);
  }
});

test("mobile navigation and not-found state are usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Open navigation").click();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();

  await page.goto("/releases/not-a-release");
  await expect(page.getByRole("heading", { name: /This signal faded out/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Return home" })).toBeVisible();
});

test("featured playlists and About Us pages are available from navigation", async ({ page }) => {
  await page.goto("/releases");

  await page.getByRole("link", { name: "Featured Playlists" }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await expect(
    page.getByRole("heading", { name: /Featured playlists for every frequency/i }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Showcase New Release Radar" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What we're listening to" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open Showcase New Release Radar on Spotify" }),
  ).toHaveAttribute(
    "href",
    "https://open.spotify.com/playlist/4l6LaMPL6duulmFe3hRR4Y?si=ebd8c808bcff40f9",
  );
  await expect(
    page.getByRole("link", { name: "Open Showcase New Release Radar on Spotify" }),
  ).toHaveAttribute("target", "_blank");
  await expect(
    page.getByRole("link", { name: "Open Showcase New Release Radar on Spotify" }).locator("img"),
  ).toHaveAttribute("src", /showcase-new-release-radar/);

  await page.getByRole("link", { name: "About Us" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: /Built around discovery/i })).toBeVisible();
  await expect(
    page.getByText('"Showcase" new music, artists, playlists, and happenings in the EDM world.'),
  ).toBeVisible();
  await expect(
    page.getByText("Curated playlists, songs, and feeds, based on what we think is cool."),
  ).toBeVisible();
  await expect(page.getByText(/Just some wonky weird EDM fanatics/)).toBeVisible();

  await page.getByRole("link", { name: "Contact Us" }).click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(page.getByRole("heading", { name: /Send us a signal/i })).toBeVisible();
  await expect(page.getByText("Contact email coming soon.")).toBeVisible();
  await expect(page.getByText("Subject: Showcase inquiry: [topic]")).toBeVisible();
});

test("local genre review keeps suggestions private until they are saved", async ({ page }) => {
  await page.goto("/local/genre-review");
  await expect(page.getByRole("heading", { name: "Artist genre review" })).toBeVisible();
  await expect(page.locator(".genre-admin-artist-list button").first()).toContainText(
    "Needs review",
  );

  await page.getByPlaceholder("Search artists").fill("CloZee");
  const clozee = page.locator(".genre-admin-artist-list button").filter({ hasText: "CloZee" });
  await expect(clozee).toContainText("Needs review");
  await clozee.click();
  await expect(page.getByText("high confidence")).toBeVisible();
  await expect(page.getByText("CloZee official biography")).toBeVisible();

  await page.getByRole("button", { name: "Use suggestion as draft" }).click();
  await expect(page.getByRole("button", { name: "Bass Music" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Experimental Bass" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(clozee).toContainText("Needs review");

  await page.getByRole("button", { name: "Save & Next" }).click();
  await expect(clozee).toContainText("2 confirmed");
});
