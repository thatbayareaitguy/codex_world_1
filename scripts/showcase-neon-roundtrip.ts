import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import postgres, { type Sql } from "postgres";

import { validateShowcasePublisherDatabaseUrl } from "../apps/scanner/src/showcase-neon-publication";
import { catalogContentSha256 } from "../apps/showcase/lib/catalog-integrity";
import {
  loadPublicCatalog,
  validateShowcasePublicDatabaseUrl,
} from "../apps/showcase/lib/catalog-source.server";
import { publicCatalog } from "../apps/showcase/lib/public-catalog";
import { buildPublicCatalogSnapshot } from "../apps/showcase/lib/public-catalog";
import { parsePublicCatalogSnapshot } from "../apps/showcase/lib/public-catalog-schema";
import { readEnvValue } from "./showcase-neon-bootstrap";

interface CurrentCatalogRow {
  readonly catalog_version: string;
  readonly content_sha256: string;
  readonly catalog: unknown;
}

interface CatalogCounts {
  readonly artists: number;
  readonly genres: number;
  readonly releases: number;
  readonly released: number;
  readonly upcoming: number;
  readonly withArtwork: number;
  readonly withSpotify: number;
  readonly collaborations: number;
  readonly tracks: number;
}

let operationStage = "startup";

function client(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
}

async function expectPermissionDenied(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42501") {
      return true;
    }
    throw error;
  }
}

function catalogCounts(catalog: typeof publicCatalog): CatalogCounts {
  return {
    artists: catalog.artists.length,
    genres: catalog.genres.length,
    releases: catalog.releases.length,
    released: catalog.releases.filter((release) => release.status === "released").length,
    upcoming: catalog.releases.filter((release) => release.status === "upcoming").length,
    withArtwork: catalog.releases.filter((release) => release.artwork !== undefined).length,
    withSpotify: catalog.releases.filter((release) => release.links.spotify !== undefined).length,
    collaborations: catalog.releases.filter((release) => release.artistCredits.length > 1).length,
    tracks: catalog.releases.reduce((total, release) => total + release.tracks.length, 0),
  };
}

async function main(): Promise<void> {
  operationStage = "local-credential-read";
  const localData = process.env.LOCALAPPDATA;
  if (localData === undefined || localData.trim() === "") {
    throw new Error("LOCALAPPDATA is required for Showcase Neon verification.");
  }
  const [publisherSource, websiteSource] = await Promise.all([
    readFile(resolve(localData, "Showcase", "neon-publisher.env"), "utf8"),
    readFile(resolve(localData, "Showcase", "neon-public-web.env"), "utf8"),
  ]);
  const publisherUrl = validateShowcasePublisherDatabaseUrl(
    readEnvValue(publisherSource, "SHOWCASE_NEON_PUBLISHER_DATABASE_URL"),
  );
  const websiteUrl = validateShowcasePublicDatabaseUrl(
    readEnvValue(websiteSource, "SHOWCASE_NEON_PUBLIC_DATABASE_URL"),
  );

  const publisher = client(publisherUrl);
  const website = client(websiteUrl);
  try {
    operationStage = "publisher-current-catalog-read";
    const [publisherRow] = await publisher<CurrentCatalogRow[]>`
      SELECT catalog_version::text, content_sha256, catalog
      FROM showcase.current_catalog
    `;
    if (publisherRow === undefined) throw new Error("The published Showcase catalog is missing.");

    operationStage = "website-current-catalog-read";
    const websiteCatalog = await loadPublicCatalog({
      environment: {
        NODE_ENV: "production",
        SHOWCASE_CATALOG_SOURCE: "neon",
        SHOWCASE_NEON_PUBLIC_DATABASE_URL: websiteUrl,
      },
      forceRefresh: true,
    });
    const storedCatalog = parsePublicCatalogSnapshot(publisherRow.catalog);
    const normalizedStoredCatalog = buildPublicCatalogSnapshot(storedCatalog);
    const localHash = catalogContentSha256(publicCatalog);
    const websiteHash = catalogContentSha256(websiteCatalog);
    const publisherHash = catalogContentSha256(storedCatalog);
    operationStage = "publisher-denied-write-check";
    const publisherCannotMutateBaseTable = await expectPermissionDenied(
      async () =>
        await publisher`UPDATE showcase.catalog_snapshots SET catalog = catalog WHERE false`,
    );
    operationStage = "website-denied-base-read-check";
    const websiteCannotReadBaseTable = await expectPermissionDenied(
      async () => await website`SELECT catalog_version FROM showcase.catalog_snapshots LIMIT 1`,
    );
    operationStage = "website-denied-publish-check";
    const websiteCannotPublish = await expectPermissionDenied(
      async () =>
        await website`
          SELECT showcase.publish_catalog(
            ${"showcase-public-v3"},
            ${new Date("2026-01-01T00:00:00.000Z")},
            ${"0".repeat(64)},
            ${website.json({})}
          )
        `,
    );
    const verification = {
      localMatchesWebsite: isDeepStrictEqual(publicCatalog, websiteCatalog),
      publishedCatalogNormalizesToLocal: isDeepStrictEqual(normalizedStoredCatalog, publicCatalog),
      localHashMatchesWebsite: localHash === websiteHash,
      publisherHashMatchesStored: publisherHash === publisherRow.content_sha256,
      publisherCannotMutateBaseTable,
      websiteCannotReadBaseTable,
      websiteCannotPublish,
    };
    if (Object.values(verification).some((value) => !value)) {
      console.error(JSON.stringify({ event: "showcase.neon.roundtrip.mismatch", verification }));
      throw new Error("The Showcase Neon round-trip verification failed.");
    }

    operationStage = "complete";
    console.log(
      JSON.stringify({
        event: "showcase.neon.roundtrip.complete",
        catalogVersion: publisherRow.catalog_version,
        contractVersion: publicCatalog.contractVersion,
        counts: catalogCounts(publicCatalog),
        verification,
      }),
    );
  } finally {
    await Promise.all([publisher.end({ timeout: 5 }), website.end({ timeout: 5 })]);
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void main().catch((error: unknown) => {
    const databaseCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/u.test(error.code)
        ? error.code
        : undefined;
    console.error(
      JSON.stringify({
        event: "showcase.neon.roundtrip.failed",
        stage: operationStage,
        ...(databaseCode === undefined ? {} : { databaseCode }),
        ...(error instanceof Error && error.message.startsWith("The Showcase")
          ? { detail: error.message }
          : {}),
        message: "Showcase Neon verification failed without exposing connection details.",
      }),
    );
    process.exitCode = 1;
  });
}
