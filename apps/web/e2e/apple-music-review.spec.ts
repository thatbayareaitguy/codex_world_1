import { expect, test, type Page } from "@playwright/test";

const candidateArtistId = "11111111-1111-4111-8111-111111111111";
const candidateReviewId = "22222222-2222-4222-8222-222222222222";
const manualArtistId = "33333333-3333-4333-8333-333333333333";
const manualReviewId = "44444444-4444-4444-8444-444444444444";

test("confirms an Apple Music candidate and removes sibling review state", async ({ page }) => {
  let decisionBody: unknown;
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        reviews: [
          {
            artistId: candidateArtistId,
            artistName: "Apple Candidate Artist",
            confidence: "0.970",
            id: candidateReviewId,
            name: "Apple Candidate Artist",
            proposedExternalId: "123456789",
            provider: "apple_music",
            reasons: ["Evidence-supported identity seed"],
            status: "pending",
          },
        ],
      }),
    });
  });
  await page.route("**/api/apple-music/mappings/decision", async (route) => {
    decisionBody = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  const card = page.getByRole("article").filter({ hasText: "Apple Candidate Artist" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Confirm or replace" }).click();
  await expect(card).toBeHidden();
  expect(decisionBody).toEqual({ decision: "confirm", reviewId: candidateReviewId });
});

test("requires and persists a numeric Apple Music ID for a candidate-free review", async ({
  page,
}) => {
  let manualBody: unknown;
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        reviews: [
          {
            artistId: manualArtistId,
            artistName: "Candidate Free Artist",
            confidence: "0.000",
            id: manualReviewId,
            name: "No Apple Music candidate found",
            proposedExternalId: null,
            provider: "apple_music",
            reasons: ["No safe candidate"],
            status: "pending",
          },
        ],
      }),
    });
  });
  await page.route("**/api/apple-music/mappings/manual", async (route) => {
    manualBody = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  const input = page.getByLabel("Apple Music artist ID");
  await input.fill("not-numeric");
  await page.getByRole("button", { name: "Confirm ID" }).click();
  await expect(page.getByText("Enter the numeric Apple Music artist ID.")).toBeVisible();
  await input.fill("987654321");
  await page.getByRole("button", { name: "Confirm ID" }).click();
  await expect(page.getByText("Candidate Free Artist")).toBeHidden();
  expect(manualBody).toEqual({ artistId: manualArtistId, externalId: "987654321" });
});

async function mockMusicBrainz(page: Page) {
  await page.route("**/api/musicbrainz/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ hasMore: false, nextCursor: null, reviews: [] }),
    });
  });
}
