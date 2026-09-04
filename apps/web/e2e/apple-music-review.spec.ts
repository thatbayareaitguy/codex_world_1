import { expect, test, type Page } from "@playwright/test";

const candidateArtistId = "11111111-1111-4111-8111-111111111111";
const candidateReviewId = "22222222-2222-4222-8222-222222222222";
const manualArtistId = "33333333-3333-4333-8333-333333333333";
const manualReviewId = "44444444-4444-4444-8444-444444444444";

test("confirms an Apple Music candidate and removes sibling review state", async ({ page }) => {
  let candidateResolved = false;
  let decisionBody: unknown;
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        summary: candidateResolved
          ? { pendingCandidates: 0, unresolvedArtists: 0 }
          : { pendingCandidates: 1, unresolvedArtists: 1 },
        reviews: candidateResolved
          ? []
          : [
              {
                artistId: candidateArtistId,
                artistName: "Apple Candidate Artist",
                confirmedEvidence: [
                  {
                    externalId: "11111111-2222-4333-8444-555555555555",
                    mappingSource: "manual_confirmation",
                    provider: "musicbrainz",
                    url: "https://musicbrainz.org/artist/11111111-2222-4333-8444-555555555555",
                  },
                ],
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
    candidateResolved = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  const card = page.getByRole("article").filter({ hasText: "Apple Candidate Artist" });
  await expect(card).toBeVisible();
  await expect(page.getByText("1 unresolved artists")).toBeVisible();
  await expect(page.getByText("1 candidate identities")).toBeVisible();
  await expect(
    page.getByRole("link", {
      name: /MusicBrainz 11111111-2222-4333-8444-555555555555/,
    }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Confirm identity" }).click();
  await expect(card).toBeHidden();
  expect(decisionBody).toEqual({ decision: "confirm", reviewId: candidateReviewId });
});

test("requires and persists a numeric Apple Music ID for a candidate-free review", async ({
  page,
}) => {
  let manualResolved = false;
  let manualBody: unknown;
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        summary: manualResolved
          ? { pendingCandidates: 0, unresolvedArtists: 0 }
          : { pendingCandidates: 1, unresolvedArtists: 1 },
        reviews: manualResolved
          ? []
          : [
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
    manualResolved = true;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  const input = page.getByLabel("Apple Music artist ID");
  await input.fill("not-numeric");
  await page.getByRole("button", { name: "Confirm ID", exact: true }).click();
  await expect(page.getByText("Enter the numeric Apple Music artist ID.")).toBeVisible();
  await input.fill("987654321");
  await page.getByRole("button", { name: "Confirm ID", exact: true }).click();
  await expect(page.getByText("Candidate Free Artist")).toBeHidden();
  expect(manualBody).toEqual({ artistId: manualArtistId, externalId: "987654321" });
});

test("persists an explicit no-result identity decision", async ({ page }) => {
  let decisionBody: unknown;
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        summary: { pendingCandidates: 1, unresolvedArtists: 1 },
        reviews: [
          {
            artistId: manualArtistId,
            artistName: "No Result Artist",
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
  await page.route("**/api/artist-identities/decision", async (route) => {
    decisionBody = route.request().postDataJSON();
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  await page.getByRole("button", { name: "Not on Apple" }).click();
  expect(decisionBody).toEqual({
    artistId: manualArtistId,
    provider: "apple_music",
    status: "confirmed_unavailable",
  });
});

test("shows ranked Apple-only evidence and submits explicit review outcomes", async ({ page }) => {
  const decisions: unknown[] = [];
  const mappingDecisions: unknown[] = [];
  const rejected = new Set<string>();
  await mockMusicBrainz(page);
  await page.route("**/api/apple-music/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hasMore: false,
        nextCursor: null,
        summary: { pendingCandidates: 2, unresolvedArtists: 1 },
        reviews: [
          rankedReview(
            "55555555-5555-4555-8555-555555555555",
            "7001",
            1,
            0.61,
            rejected.has("7001") ? "rejected" : "pending",
          ),
          rankedReview(
            "66666666-6666-4666-8666-666666666666",
            "7002",
            2,
            0.44,
            rejected.has("7002") ? "rejected" : "pending",
          ),
        ],
      }),
    });
  });
  await page.route("**/api/apple-music/mappings/decision", async (route) => {
    const body = route.request().postDataJSON() as { decision: string; reviewId: string };
    mappingDecisions.push(body);
    const externalId = body.reviewId.startsWith("5555") ? "7001" : "7002";
    if (body.decision === "reject") rejected.add(externalId);
    if (body.decision === "restore") rejected.delete(externalId);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/artist-identities/decision", async (route) => {
    decisions.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.goto("/#review");
  await page.getByLabel("Filter review queue").selectOption("apple_music_mappings");
  const group = page.getByLabel("Ranked Candidate Artist Apple Music identity review");
  await expect(group.getByText("Rank 1")).toBeVisible();
  await expect(group.getByText("Electronic").first()).toBeVisible();
  await expect(group.getByText("Example Label").first()).toBeVisible();
  await expect(group.getByText(/Distinct Release/).first()).toBeVisible();
  await expect(group.getByText(/Automatic confirmation rejected/).first()).toBeVisible();
  await expect(
    group.getByRole("link", { name: "Open First Candidate on Apple Music" }),
  ).toHaveAttribute("href", "https://music.apple.com/us/artist/7001");
  await expect(group.getByRole("button", { name: "Not on Apple" })).toBeVisible();
  await expect(group.getByRole("button", { name: "Defer" })).toBeVisible();
  const firstCandidate = group.getByRole("article").filter({ hasText: "First Candidate" });
  await firstCandidate.getByRole("button", { name: "Reject candidate" }).click();
  await expect(firstCandidate.getByRole("button", { name: "Restore candidate" })).toBeVisible();
  expect(mappingDecisions.at(-1)).toEqual({
    decision: "reject",
    reviewId: "55555555-5555-4555-8555-555555555555",
  });
  await firstCandidate.getByRole("button", { name: "Restore candidate" }).click();
  await expect(firstCandidate.getByRole("button", { name: "Reject candidate" })).toBeVisible();
  expect(mappingDecisions.at(-1)).toEqual({
    decision: "restore",
    reviewId: "55555555-5555-4555-8555-555555555555",
  });
  const splitButton = group.getByRole("button", { name: "Confirm split profile" });
  await expect(splitButton).toBeDisabled();
  await group.getByRole("checkbox", { name: "Split profile" }).nth(0).check();
  await group.getByRole("checkbox", { name: "Split profile" }).nth(1).check();
  await expect(splitButton).toBeEnabled();
  await splitButton.click();
  expect(decisions.at(-1)).toEqual({
    artistId: candidateArtistId,
    externalIds: ["7001", "7002"],
    provider: "apple_music",
    status: "split_profile",
  });
});

async function mockMusicBrainz(page: Page) {
  await page.route("**/api/musicbrainz/mappings?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ hasMore: false, nextCursor: null, reviews: [] }),
    });
  });
}

function rankedReview(
  id: string,
  externalId: string,
  rank: number,
  score: number,
  status: "pending" | "rejected",
) {
  const candidateName = rank === 1 ? "First Candidate" : "Second Candidate";
  return {
    artistId: candidateArtistId,
    artistName: "Ranked Candidate Artist",
    candidateEvidence: {
      activityDate: "2026-07-01",
      appleArtistName: candidateName,
      artistUrl: `https://music.apple.com/us/artist/${externalId}`,
      artworkUrl: "https://is1-ssl.mzstatic.com/image/thumb/Music221/example/300x300bb.jpg",
      autoConfirmEligible: false,
      collaborators: rank === 1 ? ["Confirmed Collaborator"] : [],
      contradictions: [],
      eliminationSafe: false,
      exactLinkSource: null,
      genres: ["Electronic"],
      labels: ["Example Label"],
      rank,
      rankingReasons: [
        "Automatic confirmation rejected: available signals are Apple-only ranking evidence, not an exact independent identity link.",
      ],
      resourceStatus: "valid",
      score: score.toFixed(3),
      source: "apple_music_api",
      titleOverlaps: [],
      topReleases: [{ releaseDate: "2026-07-01", title: "Distinct Release" }],
      topSongs: [{ releaseDate: "2026-07-01", title: "Distinct Song" }],
    },
    confidence: "0.500",
    confirmedEvidence: [],
    id,
    name: candidateName,
    proposedExternalId: externalId,
    provider: "apple_music",
    reasons: ["Historical candidate inventory"],
    status,
  };
}
