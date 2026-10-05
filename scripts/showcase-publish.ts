import { createDatabase } from "../packages/db/src/client";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnvironment } from "../apps/scanner/src/local-env";
import {
  AppleMusicFeedClient,
  createAppleMusicFeedDeveloperToken,
  fetchAppleMusicFeedArtwork,
  loadAppleMusicFeedCredentials,
} from "../apps/scanner/src/showcase-apple-feed";
import { applyShowcaseEditorialPolicy } from "../apps/scanner/src/showcase-editorial-policy";
import {
  buildShowcasePublicCatalog,
  loadShowcasePublicationSource,
  showcasePublicCatalogSchema,
} from "../apps/scanner/src/showcase-publication";
import {
  loadShowcasePublisherDatabaseUrl,
  publishShowcaseCatalogToNeon,
} from "../apps/scanner/src/showcase-neon-publication";
import { readPublishedCatalog } from "./showcase-neon-reader";
import { withUpdateBudget } from "./showcase-update-budget";
import { samePublication, validatePublicationChange } from "./showcase-publication-safety";
import { catalogContentSha256 } from "../apps/showcase/lib/catalog-integrity";

export async function publishShowcaseCatalog() {
  loadLocalEnvironment(
    process.env,
    process.env.SHOWCASE_SCANNER_ENV_PATH ?? resolve(process.cwd(), ".env"),
  );
  if (!process.env.DATABASE_URL) throw new Error("Scanner database configuration is required.");
  const previous = await readPublishedCatalog();
  const { client, db } = createDatabase(process.env.DATABASE_URL);
  const source = await (async () => {
    try {
      const [health] = await client<{ latest: Date | null; active: number }[]>`
        SELECT max(finished_at) FILTER (WHERE status = 'completed' AND failed_artists = 0) AS latest,
          count(*) FILTER (WHERE status = 'running')::int AS active FROM apple_music_scan_batches`;
      const maximumAge = (process.env.SHOWCASE_PUBLICATION_SCHEDULED === "true" ? 2 : 7) * 86400000;
      if (
        !health?.latest ||
        health.active > 0 ||
        Date.now() - new Date(health.latest).getTime() > maximumAge
      ) {
        throw new Error("Apple scan is active or not fresh enough; publication deferred.");
      }
      return await db.transaction((transaction) => loadShowcasePublicationSource(transaction), {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
    } finally {
      await client.end();
    }
  })();

  // Previously validated Apple Feed artwork can only be reused for the same exact Apple URL.
  const previousArtwork = new Map(
    previous.releases.map((release) => [release.links.appleMusic, release.artwork]),
  );
  const withPreviousArtwork = source.releases.map((release) => {
    const artwork = previousArtwork.get(release.appleMusicUrl);
    return artwork ? { ...release, artwork } : release;
  });
  const build = async (releases: typeof source.releases) =>
    showcasePublicCatalogSchema.parse(
      await applyShowcaseEditorialPolicy(
        buildShowcasePublicCatalog({ ...source, releases }).catalog,
        {
          confirmedGenres: resolve("apps/showcase/lib/confirmed-artist-genres.json"),
          excludedArtists: resolve("apps/showcase/lib/excluded-public-artists.json"),
        },
      ),
    );
  let catalog = await build(withPreviousArtwork);
  validatePublicationChange(previous, catalog);
  let changed = !samePublication(previous, catalog);
  // No Feed/network enrichment work for an unchanged publication.
  if (changed) {
    const missingIds = withPreviousArtwork
      .filter((release) => !release.artwork)
      .map((release) => release.appleProviderReleaseId);
    if (missingIds.length > 0) {
      try {
        const credentials = loadAppleMusicFeedCredentials();
        const client = new AppleMusicFeedClient({
          developerToken: createAppleMusicFeedDeveloperToken(credentials),
        });
        const deadline = AbortSignal.timeout(20 * 60_000);
        const feed = await fetchAppleMusicFeedArtwork({
          appleReleaseIds: missingIds,
          client,
          fetchImpl: (input, init) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]),
            }),
        });
        catalog = await build(
          withPreviousArtwork.map((release) => {
            const artwork =
              release.artwork ?? feed.artworkByAppleReleaseId.get(release.appleProviderReleaseId);
            return artwork ? { ...release, artwork } : release;
          }),
        );
      } catch {
        console.warn(
          "Showcase Feed enrichment unavailable; preserving exact prior artwork and neutral placeholders.",
        );
      }
    }
    validatePublicationChange(previous, catalog);
    await publishShowcaseCatalogToNeon(catalog, await loadShowcasePublisherDatabaseUrl());
    const readback = await readPublishedCatalog();
    if (catalogContentSha256(readback) !== catalogContentSha256(catalog))
      throw new Error("Neon round-trip verification failed.");
  } else {
    // Do not mint new versions merely because generatedAt changed.
    catalog = showcasePublicCatalogSchema.parse(previous);
    changed = false;
  }
  const outputPath = resolve("apps/showcase/lib/generated-public-catalog.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(`${outputPath}.${process.pid}.tmp`, `${JSON.stringify(catalog, null, 2)}\n`, {
    flag: "wx",
  });
  await rename(`${outputPath}.${process.pid}.tmp`, outputPath);
  const result = {
    changed,
    contentSha256: catalogContentSha256(catalog),
    generatedAt: catalog.generatedAt,
    artists: catalog.artists.length,
    releases: catalog.releases.length,
    genres: catalog.genres.length,
    artwork: catalog.releases.filter((r) => r.artwork).length,
  };
  console.info(JSON.stringify({ event: "showcase.catalog_published", ...result }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void withUpdateBudget("manual", publishShowcaseCatalog).catch(() => {
    console.error(
      "Showcase publication failed or deferred. Check readiness, local budget ledger, credentials, and service availability. No credentials are logged.",
    );
    process.exitCode = 1;
  });
}
