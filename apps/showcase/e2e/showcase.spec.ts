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
  await releaseCard.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/releases/${upcomingRelease!.slug}$`));
  await expect(page.getByRole("heading", { name: upcomingRelease!.title, level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Apple Music/i })).toHaveAttribute(
    "target",
    "_blank",
  );
});

test("artist filtering and structured profile work", async ({ page }) => {
  await page.goto("/artists");

  await page.getByPlaceholder("Filter by artist or genre").fill("jungle");
  await expect(page.getByText("Showing 1")).toBeVisible();
  await page.getByRole("link", { name: /Night Service/i }).click();
  await expect(page).toHaveURL(/\/artists\/night-service$/);
  await expect(page.getByRole("heading", { name: "Night Service", level: 1 })).toBeVisible();
  await expect(page.getByText("Subframe")).toBeVisible();
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
});
