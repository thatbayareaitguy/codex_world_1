import { expect, test, type Page } from "@playwright/test";
import type { FeedFixtureItem } from "@radar/core";
import { feedFixtures } from "@radar/testing";

const artwork = {
  albumId: "albumArtworkTest000001",
  albumUrl: "https://open.spotify.com/album/albumArtworkTest000001",
  image: { height: 300, url: "https://i.scdn.co/image/artworktest", width: 300 },
  lastObservedAt: "2026-07-20T12:00:00.000Z",
  sourceProvider: "spotify" as const,
};

test("renders direct Spotify artwork with a safe album link and preserves it on refresh", async ({
  page,
}) => {
  const item = spotifyArtworkItem("spotify-artwork-single", "Signal Bloom");
  await mockFeed(page, [item]);
  await fulfillArtwork(page);
  await page.setViewportSize({ width: 480, height: 800 });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();

  const link = page.getByRole("link", { name: "Open Signal Bloom by Artwork Artist on Spotify" });
  const image = page.getByRole("img", {
    name: "Album artwork for Signal Bloom by Artwork Artist",
  });
  await expect(link).toHaveAttribute("href", artwork.albumUrl);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(image).toHaveAttribute("src", artwork.image.url);
  await expect(image).toHaveCSS("object-fit", "contain");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);

  await page.getByRole("button", { name: "Refresh feed" }).click();
  await expect(image).toBeVisible();
});

test("shows artwork on every grouped track and keeps the header artwork when collapsed", async ({
  page,
}) => {
  const groupedItems = [
    spotifyArtworkItem("group-track-one", "First Track", "Grouped Album"),
    spotifyArtworkItem("group-track-two", "Second Track", "Grouped Album"),
  ];
  await mockFeed(page, groupedItems);
  await fulfillArtwork(page);

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();

  const group = page.getByRole("region", { name: "Artwork Artist - Grouped Album Album" });
  await expect(group.getByRole("img")).toHaveCount(3);
  await expect(group.locator(".release-feed-group-items .spotify-artwork-cover")).toHaveCount(2);
  await group
    .getByRole("button", { name: "Collapse Artwork Artist - Grouped Album Album" })
    .click();
  await expect(group.getByRole("img")).toHaveCount(1);
  await expect(group.locator(".spotify-group-artwork")).toBeVisible();
  await expect(group).toHaveClass(/is-collapsed/);
});

test("uses the existing fallback when artwork is absent or cannot load", async ({ page }) => {
  const absent = { ...feedFixtures[0]!, id: "absent-art", title: "Absent Artwork" };
  const musicbrainzOnly = {
    ...feedFixtures[0]!,
    artist: "MusicBrainz Artist",
    id: "musicbrainz-only-art",
    releaseTitle: "MusicBrainz Release",
    sources: [
      {
        evidenceHref: "https://musicbrainz.org/release/00000000-0000-4000-8000-000000000001",
        href: "https://musicbrainz.org/release/00000000-0000-4000-8000-000000000001",
        provider: "MusicBrainz",
      },
    ],
    title: "MusicBrainz Only",
  };
  const broken = spotifyArtworkItem("broken-art", "Broken Artwork");
  broken.spotifyArtwork = {
    ...artwork,
    image: { ...artwork.image, url: "https://i.scdn.co/image/brokenart" },
  };
  await mockFeed(page, [absent, musicbrainzOnly, broken]);
  await page.route("https://i.scdn.co/image/brokenart", async (route) => {
    await route.fulfill({ body: "", status: 404 });
  });

  await page.goto("/?e2e-scan-status=database#feed");
  await page.getByRole("button", { name: "Refresh feed" }).click();

  await expect(page.locator("article .cover:not(.spotify-artwork-cover)")).toHaveCount(3);
  await expect(page.getByRole("img", { name: /Broken Artwork/ })).toHaveCount(0);
  await expect(page.getByRole("img", { name: /MusicBrainz Release/ })).toHaveCount(0);
});

function spotifyArtworkItem(id: string, title: string, releaseTitle = title): FeedFixtureItem {
  return {
    ...feedFixtures[0]!,
    artist: "Artwork Artist",
    id,
    releaseTitle,
    releaseType: releaseTitle === title ? "single" : "album",
    sources: [
      {
        evidenceHref: `https://open.spotify.com/track/${id}`,
        href: `https://open.spotify.com/track/${id}`,
        provider: "Spotify",
      },
    ],
    spotifyArtwork: {
      ...artwork,
      albumId: releaseTitle === title ? artwork.albumId : "groupedAlbumArtwork001",
      albumUrl:
        releaseTitle === title
          ? artwork.albumUrl
          : "https://open.spotify.com/album/groupedAlbumArtwork001",
    },
    title,
  };
}

async function mockFeed(page: Page, items: FeedFixtureItem[]): Promise<void> {
  await page.route("**/api/feed**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get("mode") === "revision") {
      await route.fulfill({ json: { count: items.length, revision: "artwork-revision" } });
      return;
    }
    await route.fulfill({
      json: { count: items.length, items, revision: "artwork-revision" },
    });
  });
}

async function fulfillArtwork(page: Page): Promise<void> {
  await page.route("https://i.scdn.co/image/**", async (route) => {
    await route.fulfill({
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
      contentType: "image/png",
      status: 200,
    });
  });
}
