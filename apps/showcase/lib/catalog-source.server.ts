import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";

import { catalogContentSha256 } from "./catalog-integrity";
import {
  buildPublicCatalogSnapshot,
  publicCatalog as generatedPublicCatalog,
  type PublicCatalogSnapshot,
} from "./public-catalog";
import { parsePublicCatalogSnapshot } from "./public-catalog-schema";

const publicDatabaseVariable = "SHOWCASE_NEON_PUBLIC_DATABASE_URL";
const cacheDurationMs = 60_000;

interface CatalogCache {
  readonly catalog: PublicCatalogSnapshot;
  readonly expiresAt: number;
}

interface LoadCatalogOptions {
  readonly credentialPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly forceRefresh?: boolean;
  readonly now?: number;
}

interface CurrentCatalogRow {
  readonly catalog_version: string;
  readonly contract_version: string;
  readonly content_sha256: string;
  readonly catalog: unknown;
}

let cachedNeonCatalog: CatalogCache | undefined;

function readEnvValue(source: string, variableName: string): string | undefined {
  const prefix = `${variableName}=`;
  const line = source
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) return undefined;
  const rawValue = line.slice(prefix.length).trim();
  const value =
    rawValue.length >= 2 &&
    ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'")))
      ? rawValue.slice(1, -1)
      : rawValue;
  return value.trim() === "" ? undefined : value;
}

export function validateShowcasePublicDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Showcase public database URL is invalid.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("The Showcase public database URL must use PostgreSQL.");
  }
  if (parsed.username !== "showcase_web_readonly") {
    throw new Error("The Showcase runtime requires the read-only website role.");
  }
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new Error("The Showcase public database URL must target Neon.");
  }
  if (!parsed.hostname.toLowerCase().includes("-pooler")) {
    throw new Error("The Showcase public database URL must use the pooled Neon endpoint.");
  }
  if (parsed.searchParams.get("sslmode") !== "require") {
    throw new Error("The Showcase public database URL must require TLS.");
  }
  if (parsed.password === "") throw new Error("The Showcase public database password is missing.");
  return parsed.toString();
}

async function resolvePublicDatabaseUrl(options: LoadCatalogOptions): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const configured = environment[publicDatabaseVariable];
  if (configured !== undefined && configured.trim() !== "") {
    return validateShowcasePublicDatabaseUrl(configured);
  }

  const localData = environment.LOCALAPPDATA;
  const credentialPath =
    options.credentialPath ??
    (localData === undefined ? undefined : resolve(localData, "Showcase", "neon-public-web.env"));
  if (credentialPath === undefined) return undefined;

  try {
    const source = await readFile(credentialPath, "utf8");
    const value = readEnvValue(source, publicDatabaseVariable);
    return value === undefined ? undefined : validateShowcasePublicDatabaseUrl(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readCatalogFromNeon(databaseUrl: string): Promise<PublicCatalogSnapshot> {
  const sql = postgres(databaseUrl, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  try {
    const [row] = await sql<CurrentCatalogRow[]>`
      SELECT
        catalog_version::text,
        contract_version,
        content_sha256,
        catalog
      FROM showcase.current_catalog
    `;
    if (row === undefined) throw new Error("The Showcase Neon catalog has not been published yet.");
    if (row.contract_version !== "showcase-public-v3") {
      throw new Error("The Showcase Neon catalog contract version is unsupported.");
    }
    const storedCatalog = parsePublicCatalogSnapshot(row.catalog);
    if (catalogContentSha256(storedCatalog) !== row.content_sha256) {
      throw new Error("The Showcase Neon catalog integrity check failed.");
    }
    const catalog = buildPublicCatalogSnapshot(storedCatalog);
    console.info(
      JSON.stringify({
        event: "showcase.catalog.loaded",
        source: "neon",
        catalogVersion: row.catalog_version,
        artistCount: catalog.artists.length,
        genreCount: catalog.genres.length,
        releaseCount: catalog.releases.length,
      }),
    );
    return catalog;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function loadPublicCatalog(
  options: LoadCatalogOptions = {},
): Promise<PublicCatalogSnapshot> {
  const environment = options.environment ?? process.env;
  const requestedSource = environment.SHOWCASE_CATALOG_SOURCE?.trim().toLowerCase();
  if (requestedSource !== undefined && !["json", "neon"].includes(requestedSource)) {
    throw new Error("SHOWCASE_CATALOG_SOURCE must be either json or neon.");
  }
  if (environment.VERCEL === "1" && requestedSource === "json") {
    throw new Error("Vercel Showcase deployments must use Neon.");
  }
  if (requestedSource === "json") return generatedPublicCatalog;

  const now = options.now ?? Date.now();
  if (
    !options.forceRefresh &&
    cachedNeonCatalog !== undefined &&
    cachedNeonCatalog.expiresAt > now
  ) {
    return cachedNeonCatalog.catalog;
  }

  const databaseUrl = await resolvePublicDatabaseUrl(options);
  if (databaseUrl === undefined) {
    if (requestedSource === "neon" || environment.VERCEL === "1") {
      throw new Error("The Showcase read-only Neon database credential is required.");
    }
    return generatedPublicCatalog;
  }

  const catalog = await readCatalogFromNeon(databaseUrl);
  cachedNeonCatalog = { catalog, expiresAt: now + cacheDurationMs };
  return catalog;
}

export function clearPublicCatalogCache(): void {
  cachedNeonCatalog = undefined;
}
