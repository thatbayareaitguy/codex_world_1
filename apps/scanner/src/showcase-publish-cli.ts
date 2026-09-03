import { createDatabase } from "@radar/db";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";
import {
  AppleMusicFeedClient,
  createAppleMusicFeedDeveloperToken,
  fetchAppleMusicFeedArtwork,
  loadAppleMusicFeedCredentials,
} from "./showcase-apple-feed";
import { applyShowcaseEditorialPolicy } from "./showcase-editorial-policy";
import { buildShowcasePublicCatalog, loadShowcasePublicationSource } from "./showcase-publication";
import { showcasePublicCatalogSchema } from "./showcase-publication";
import {
  loadShowcasePublisherDatabaseUrl,
  publishShowcaseCatalogToNeon,
} from "./showcase-neon-publication";

const outputPath = resolve(process.cwd(), "apps/showcase/lib/generated-public-catalog.json");

async function main(): Promise<void> {
  loadLocalEnvironment(
    process.env,
    process.env.SHOWCASE_SCANNER_ENV_PATH ?? resolve(process.cwd(), ".env"),
  );
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const { client, db } = createDatabase(databaseUrl);
  const source = await (async () => {
    try {
      return await loadShowcasePublicationSource(db);
    } finally {
      await client.end();
    }
  })();

  const credentials = loadAppleMusicFeedCredentials();
  const developerToken = createAppleMusicFeedDeveloperToken(credentials);
  const feedClient = new AppleMusicFeedClient({ developerToken });
  const feedResult = await fetchAppleMusicFeedArtwork({
    appleReleaseIds: source.releases.map((release) => release.appleProviderReleaseId),
    client: feedClient,
    onProgress: (progress) => {
      if (progress.partNumber % 10 !== 0 && progress.partNumber !== progress.partCount) return;
      process.stdout.write(
        `${JSON.stringify({ event: "showcase.apple_feed_progress", ...progress })}\n`,
      );
    },
  });
  const enrichedSource = {
    ...source,
    releases: source.releases.map((release) => {
      const artwork = feedResult.artworkByAppleReleaseId.get(release.appleProviderReleaseId);
      return artwork === undefined ? release : { ...release, artwork };
    }),
  };
  const result = buildShowcasePublicCatalog(enrichedSource);
  const catalog = showcasePublicCatalogSchema.parse(
    await applyShowcaseEditorialPolicy(result.catalog, {
      confirmedGenres: resolve(
        process.cwd(),
        "apps",
        "showcase",
        "lib",
        "confirmed-artist-genres.json",
      ),
      excludedArtists: resolve(
        process.cwd(),
        "apps",
        "showcase",
        "lib",
        "excluded-public-artists.json",
      ),
    }),
  );
  const neonPublication = await publishShowcaseCatalogToNeon(
    catalog,
    await loadShowcasePublisherDatabaseUrl(),
  );
  await writeCatalogAtomically(outputPath, `${JSON.stringify(catalog, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      event: "showcase.catalog_published",
      artistCount: catalog.artists.length,
      artistsWithGenresCount: catalog.artists.filter((artist) => artist.genreSlugs.length > 0)
        .length,
      invalidActiveArtistCount: result.invalidActiveArtistCount,
      invalidAppleReleaseCount: result.invalidAppleReleaseCount,
      multiCreditReleaseCount: catalog.releases.filter(
        (release) => release.artistCredits.length > 1,
      ).length,
      feedExportPartCount: feedResult.exportPartCount,
      feedPartsScanned: feedResult.partsScanned,
      neonCatalogVersion: neonPublication.catalogVersion,
      contentSha256: neonPublication.contentSha256,
      outputPath,
      releaseCount: catalog.releases.length,
      genreCount: catalog.genres.length,
      unresolvedCollaboratorCount: result.unresolvedCollaboratorCount,
      withSpotifyCount: catalog.releases.filter((release) => release.links.spotify !== undefined)
        .length,
      withoutSpotifyCount: catalog.releases.filter((release) => release.links.spotify === undefined)
        .length,
      withArtworkCount: catalog.releases.filter((release) => release.artwork !== undefined).length,
      withoutArtworkCount: catalog.releases.filter((release) => release.artwork === undefined)
        .length,
    })}\n`,
  );
}

async function writeCatalogAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

await main();
