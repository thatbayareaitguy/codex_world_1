import { createDatabase } from "@radar/db";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadLocalEnvironment } from "./local-env";
import { buildShowcasePublicCatalog, loadShowcasePublicationSource } from "./showcase-publication";

const outputPath = resolve(process.cwd(), "apps/showcase/lib/generated-public-catalog.json");

async function main(): Promise<void> {
  loadLocalEnvironment();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const { client, db } = createDatabase(databaseUrl);
  try {
    const source = await loadShowcasePublicationSource(db);
    const result = buildShowcasePublicCatalog(source);
    await writeCatalogAtomically(outputPath, `${JSON.stringify(result.catalog, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        event: "showcase.catalog_published",
        invalidAppleReleaseCount: result.invalidAppleReleaseCount,
        outputPath,
        releaseCount: result.releaseCount,
        withSpotifyCount: result.withSpotifyCount,
        withoutSpotifyCount: result.withoutSpotifyCount,
      })}\n`,
    );
  } finally {
    await client.end();
  }
}

async function writeCatalogAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, path);
}

await main();
