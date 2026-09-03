import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import postgres from "postgres";

import type { ShowcasePublicCatalog } from "./showcase-publication";

const publisherVariable = "SHOWCASE_NEON_PUBLISHER_DATABASE_URL";

interface PublishCatalogResult {
  readonly catalogVersion: string;
  readonly contentSha256: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Catalog numbers must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Readonly<Record<string, unknown>>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Catalog contains a value that JSON cannot represent.");
}

export function catalogContentSha256(catalog: unknown): string {
  return createHash("sha256").update(canonicalJson(catalog)).digest("hex");
}

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

export function validateShowcasePublisherDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("The Showcase publisher database URL is invalid.");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("The Showcase publisher database URL must use PostgreSQL.");
  }
  if (parsed.username !== "showcase_publisher") {
    throw new Error("Showcase publication requires the restricted publisher role.");
  }
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new Error("The Showcase publisher database URL must target Neon.");
  }
  if (parsed.hostname.toLowerCase().includes("-pooler")) {
    throw new Error("Showcase publication requires the direct Neon endpoint.");
  }
  if (parsed.searchParams.get("sslmode") !== "require") {
    throw new Error("The Showcase publisher database URL must require TLS.");
  }
  if (parsed.password === "") throw new Error("The Showcase publisher password is missing.");
  return parsed.toString();
}

export async function loadShowcasePublisherDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
  credentialPath = resolve(environment.LOCALAPPDATA ?? "", "Showcase", "neon-publisher.env"),
): Promise<string> {
  const configured = environment[publisherVariable];
  if (configured !== undefined && configured.trim() !== "") {
    return validateShowcasePublisherDatabaseUrl(configured);
  }
  if (environment.LOCALAPPDATA === undefined || environment.LOCALAPPDATA.trim() === "") {
    throw new Error("LOCALAPPDATA is required for the Showcase publisher credential.");
  }
  const source = await readFile(credentialPath, "utf8");
  const value = readEnvValue(source, publisherVariable);
  if (value === undefined) throw new Error(`${publisherVariable} is missing.`);
  return validateShowcasePublisherDatabaseUrl(value);
}

export async function publishShowcaseCatalogToNeon(
  catalog: ShowcasePublicCatalog,
  databaseUrl: string,
): Promise<PublishCatalogResult> {
  const validatedUrl = validateShowcasePublisherDatabaseUrl(databaseUrl);
  const contentSha256 = catalogContentSha256(catalog);
  const sql = postgres(validatedUrl, {
    connect_timeout: 15,
    idle_timeout: 5,
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  try {
    const [row] = await sql<{ catalog_version: string }[]>`
      SELECT showcase.publish_catalog(
        ${catalog.contractVersion},
        ${new Date(catalog.generatedAt)},
        ${contentSha256},
        ${sql.json(catalog)}
      )::text AS catalog_version
    `;
    if (row === undefined) throw new Error("Neon did not return a Showcase catalog version.");
    return { catalogVersion: row.catalog_version, contentSha256 };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
