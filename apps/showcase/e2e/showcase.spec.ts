import { expect, test } from "@playwright/test";

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
  await page.goto("/releases");

  await expect(page.getByRole("heading", { name: /What is landing right now/i })).toBeVisible();
  await page.getByRole("button", { name: "Upcoming" }).click();
  await expect(page.getByText("2 releases")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Phase Lines" })).toBeVisible();
  await page.getByRole("link", { name: /Phase Lines/i }).click();
  await expect(page).toHaveURL(/\/releases\/phase-lines$/);
  await expect(page.getByRole("heading", { name: "Phase Lines", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: /Spotify/i })).toHaveAttribute("target", "_blank");
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
  await expect(page.getByRole("heading", { name: "Afterhours Signal" })).toBeVisible();

  await page.getByRole("link", { name: "About Us" }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { name: /Built around discovery/i })).toBeVisible();
  await expect(page.getByText("The full About Us content will be added later.")).toBeVisible();
});
