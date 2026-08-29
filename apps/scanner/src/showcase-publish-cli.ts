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
import { buildShowcasePublicCatalog, loadShowcasePublicationSource } from "./showcase-publication";

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
  await writeCatalogAtomically(outputPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({
      event: "showcase.catalog_published",
      artistCount: result.artistCount,
      artistsWithGenresCount: result.artistsWithGenresCount,
      invalidActiveArtistCount: result.invalidActiveArtistCount,
      invalidAppleReleaseCount: result.invalidAppleReleaseCount,
      multiCreditReleaseCount: result.multiCreditReleaseCount,
      feedExportPartCount: feedResult.exportPartCount,
      feedPartsScanned: feedResult.partsScanned,
      outputPath,
      releaseCount: result.releaseCount,
      unresolvedCollaboratorCount: result.unresolvedCollaboratorCount,
      withSpotifyCount: result.withSpotifyCount,
      withoutSpotifyCount: result.withoutSpotifyCount,
      withArtworkCount: result.withArtworkCount,
      withoutArtworkCount: result.withoutArtworkCount,
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
