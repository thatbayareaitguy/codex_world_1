import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadLocalEnvironment } from "./local-env";

export const fullWatchlistIdentityTransactionMode = "isolation level repeatable read read only";

export const fullWatchlistIdentityQueries = {
  artists: `
    select
      a.id::text as canonical_artist_id,
      a.name as display_name,
      a.normalized_name,
      true as active,
      ae.external_id as spotify_artist_id,
      coalesce(
        array(
          select aliases.name
          from artist_aliases aliases
          where aliases.artist_id = a.id
          order by aliases.normalized_name, aliases.name
        ),
        '{}'::text[]
      ) as aliases
    from artists a
    join artist_external_ids ae
      on ae.artist_id = a.id
     and ae.provider = 'spotify'
     and ae.confirmed = true
    where exists (
      select 1
      from artist_follows follows
      where follows.artist_id = a.id
        and follows.active = true
    )
    order by a.normalized_name, a.id
  `,
  schemaVersion: "select count(*)::int as source_schema_version from drizzle.__drizzle_migrations",
  timestamp: "select now() as snapshot_timestamp",
} as const;

const allowedReadTables = new Set([
  "artists",
  "artist_aliases",
  "artist_external_ids",
  "artist_follows",
  "drizzle.__drizzle_migrations",
]);

export interface FullWatchlistIdentityArtist {
  active: true;
  aliases: string[];
  canonicalArtistId: string;
  displayName: string;
  normalizedName: string;
  spotifyArtistId: string;
}

export interface FullWatchlistIdentitySnapshot {
  artists: FullWatchlistIdentityArtist[];
  canonicalContentSha256: string;
  snapshotId: string;
  snapshotTimestamp: string;
  sourceSchemaVersion: number;
  version: 1;
}

export interface FullWatchlistIdentityExportResult {
  canonicalContentSha256: string;
  fileByteSha256: string;
  outputPath: string;
  snapshot: FullWatchlistIdentitySnapshot;
}

export interface IdentitySnapshotReadTransaction {
  query(statement: string): Promise<unknown[]>;
}

export interface IdentitySnapshotReader {
  transaction<T>(
    mode: string,
    work: (transaction: IdentitySnapshotReadTransaction) => Promise<T>,
  ): Promise<T>;
}

interface RawIdentityArtist {
  active: boolean;
  aliases: unknown;
  canonical_artist_id: string;
  display_name: string;
  normalized_name: string;
  spotify_artist_id: string;
}

export async function exportFullWatchlistIdentitySnapshot(input: {
  outputDirectory: string;
  sourceEnvironmentPath: string;
}): Promise<FullWatchlistIdentityExportResult> {
  const sourceEnvironment = loadLocalEnvironment({}, input.sourceEnvironmentPath);
  const databaseUrl = sourceEnvironment.DATABASE_URL;
  if (!databaseUrl) throw new Error("The source environment has no DATABASE_URL.");
  const sql = postgres(databaseUrl, {
    connection: { application_name: "itunes-full-watchlist-identity-readonly" },
    max: 1,
  });
  const reader: IdentitySnapshotReader = {
    transaction: async (mode, work) => {
      const result = await sql.begin(mode, (tx) =>
        work({
          query: async (statement) => {
            assertIdentitySnapshotReadOnlyStatement(statement);
            return tx.unsafe(statement);
          },
        }),
      );
      return result as Awaited<ReturnType<typeof work>>;
    },
  };
  try {
    const snapshot = await collectFullWatchlistIdentitySnapshot(reader);
    return writeFullWatchlistIdentitySnapshot(snapshot, input.outputDirectory);
  } finally {
    await sql.end();
  }
}

export async function collectFullWatchlistIdentitySnapshot(
  reader: IdentitySnapshotReader,
): Promise<FullWatchlistIdentitySnapshot> {
  return reader.transaction(fullWatchlistIdentityTransactionMode, async (transaction) => {
    const timestampRows = await guardedQuery(transaction, fullWatchlistIdentityQueries.timestamp);
    const schemaRows = await guardedQuery(transaction, fullWatchlistIdentityQueries.schemaVersion);
    const artistRows = await guardedQuery(transaction, fullWatchlistIdentityQueries.artists);
    const snapshotTimestamp = dateValue(
      (timestampRows[0] as { snapshot_timestamp?: unknown } | undefined)?.snapshot_timestamp,
      "snapshot timestamp",
    ).toISOString();
    const sourceSchemaVersion = integerValue(
      (schemaRows[0] as { source_schema_version?: unknown } | undefined)?.source_schema_version,
      "source schema version",
    );
    const artists = (artistRows as unknown as RawIdentityArtist[]).map(normalizeRawArtist);
    const snapshotId = `itunes-full-watchlist-identity-${snapshotTimestamp.replace(/[:.]/g, "-")}`;
    const canonicalContent = canonicalIdentitySnapshotContent({
      artists,
      snapshotId,
      snapshotTimestamp,
      sourceSchemaVersion,
      version: 1,
    });
    const snapshot: FullWatchlistIdentitySnapshot = {
      ...canonicalContent,
      canonicalContentSha256: sha256(canonicalIdentitySnapshotBytes(canonicalContent)),
    };
    validateFullWatchlistIdentitySnapshot(snapshot);
    return snapshot;
  });
}

export async function writeFullWatchlistIdentitySnapshot(
  snapshot: FullWatchlistIdentitySnapshot,
  outputDirectory: string,
): Promise<FullWatchlistIdentityExportResult> {
  validateFullWatchlistIdentitySnapshot(snapshot);
  const outputPath = resolve(outputDirectory, `${snapshot.snapshotId}.json`);
  await mkdir(resolve(outputDirectory), { recursive: true });
  const bytes = serializeFullWatchlistIdentitySnapshot(snapshot);
  await writeFile(outputPath, bytes, { encoding: "utf8", flag: "wx" });
  return {
    canonicalContentSha256: snapshot.canonicalContentSha256,
    fileByteSha256: sha256(bytes),
    outputPath,
    snapshot,
  };
}

export async function readFullWatchlistIdentitySnapshot(
  path: string,
): Promise<FullWatchlistIdentitySnapshot> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  validateFullWatchlistIdentitySnapshot(parsed);
  return parsed;
}

export function serializeFullWatchlistIdentitySnapshot(
  snapshot: FullWatchlistIdentitySnapshot,
): string {
  validateFullWatchlistIdentitySnapshot(snapshot);
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function validateFullWatchlistIdentitySnapshot(
  value: unknown,
): asserts value is FullWatchlistIdentitySnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The identity snapshot must be an object.");
  }
  const snapshot = value as Partial<FullWatchlistIdentitySnapshot>;
  if (
    snapshot.version !== 1 ||
    typeof snapshot.snapshotId !== "string" ||
    typeof snapshot.snapshotTimestamp !== "string" ||
    !Number.isInteger(snapshot.sourceSchemaVersion) ||
    !Array.isArray(snapshot.artists) ||
    snapshot.artists.length === 0
  ) {
    throw new Error("The full-watchlist identity snapshot is incomplete.");
  }
  dateValue(snapshot.snapshotTimestamp, "snapshot timestamp");
  const canonicalIds = new Set<string>();
  const spotifyIds = new Set<string>();
  for (const artist of snapshot.artists) {
    if (
      !artist ||
      typeof artist !== "object" ||
      artist.active !== true ||
      !validUuid(artist.canonicalArtistId) ||
      !nonemptyString(artist.displayName) ||
      !nonemptyString(artist.normalizedName) ||
      !nonemptyString(artist.spotifyArtistId) ||
      !Array.isArray(artist.aliases) ||
      artist.aliases.some((alias) => !nonemptyString(alias))
    ) {
      throw new Error("The identity snapshot contains an invalid artist row.");
    }
    if (canonicalIds.has(artist.canonicalArtistId)) {
      throw new Error(`Duplicate canonical artist ID: ${artist.canonicalArtistId}`);
    }
    if (spotifyIds.has(artist.spotifyArtistId)) {
      throw new Error(`Duplicate confirmed Spotify artist ID: ${artist.spotifyArtistId}`);
    }
    canonicalIds.add(artist.canonicalArtistId);
    spotifyIds.add(artist.spotifyArtistId);
  }
  const forbidden = findForbiddenIdentityKey(snapshot);
  if (forbidden) throw new Error(`Identity snapshot contains prohibited field: ${forbidden}`);
  const canonicalContent = canonicalIdentitySnapshotContent({
    artists: snapshot.artists,
    snapshotId: snapshot.snapshotId,
    snapshotTimestamp: snapshot.snapshotTimestamp,
    sourceSchemaVersion: snapshot.sourceSchemaVersion!,
    version: 1,
  });
  if (
    !/^[0-9a-f]{64}$/.test(snapshot.canonicalContentSha256 ?? "") ||
    sha256(canonicalIdentitySnapshotBytes(canonicalContent)) !== snapshot.canonicalContentSha256
  ) {
    throw new Error("The canonical-content SHA-256 does not match the identity snapshot.");
  }
  if (JSON.stringify(canonicalContent.artists) !== JSON.stringify(snapshot.artists)) {
    throw new Error("Identity snapshot artist order or normalization is not canonical.");
  }
}

export function assertIdentitySnapshotReadOnlyStatement(statement: string): void {
  const normalized = statement
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("Identity snapshot export permits SELECT statements only.");
  }
  if (
    /\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh|lock)\b/.test(
      normalized,
    ) ||
    /\bpg_(advisory|try_advisory)_/.test(normalized) ||
    /\bfor\s+(update|share|no key update|key share)\b/.test(normalized)
  ) {
    throw new Error("Identity snapshot export rejected a write, lock, or DDL statement.");
  }
  const references = [...normalized.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)].map(
    (match) => match[1]!,
  );
  const disallowed = references.find(
    (reference) => !allowedReadTables.has(reference) && !["eligible"].includes(reference),
  );
  if (disallowed) {
    throw new Error(`Identity snapshot query references a prohibited table: ${disallowed}`);
  }
}

async function guardedQuery(
  transaction: IdentitySnapshotReadTransaction,
  statement: string,
): Promise<unknown[]> {
  assertIdentitySnapshotReadOnlyStatement(statement);
  return transaction.query(statement);
}

function canonicalIdentitySnapshotContent(input: {
  artists: FullWatchlistIdentityArtist[];
  snapshotId: string;
  snapshotTimestamp: string;
  sourceSchemaVersion: number;
  version: 1;
}): Omit<FullWatchlistIdentitySnapshot, "canonicalContentSha256"> {
  return {
    artists: input.artists
      .map((artist) => ({
        active: true as const,
        aliases: [...new Set(artist.aliases.map(normalizedText))].sort(compareText),
        canonicalArtistId: normalizedText(artist.canonicalArtistId),
        displayName: normalizedText(artist.displayName),
        normalizedName: normalizedText(artist.normalizedName),
        spotifyArtistId: normalizedText(artist.spotifyArtistId),
      }))
      .sort(
        (left, right) =>
          compareText(left.normalizedName, right.normalizedName) ||
          compareText(left.canonicalArtistId, right.canonicalArtistId),
      ),
    snapshotId: normalizedText(input.snapshotId),
    snapshotTimestamp: dateValue(input.snapshotTimestamp, "snapshot timestamp").toISOString(),
    sourceSchemaVersion: input.sourceSchemaVersion,
    version: 1,
  };
}

function canonicalIdentitySnapshotBytes(
  value: Omit<FullWatchlistIdentitySnapshot, "canonicalContentSha256">,
): string {
  return JSON.stringify(value);
}

function normalizeRawArtist(row: RawIdentityArtist): FullWatchlistIdentityArtist {
  return {
    active: true,
    aliases: Array.isArray(row.aliases)
      ? row.aliases.filter((value): value is string => typeof value === "string")
      : [],
    canonicalArtistId: row.canonical_artist_id,
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    spotifyArtistId: row.spotify_artist_id,
  };
}

function findForbiddenIdentityKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findForbiddenIdentityKey(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleLowerCase("en-US");
    if (
      /(^|_)(releases?|tracks?|titles?|release_dates?|credentials?|tokens?|accounts?|telemetry|campaigns?|schedulers?|cooldowns?|leases?|locks?|playlists?|feeds?|payloads?|request_events?|request_headers?|authorization|oauth|secrets?)(_|$)/.test(
        normalizedKey,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const result = findForbiddenIdentityKey(child, path ? `${path}.${key}` : key);
    if (result) return result;
  }
  return undefined;
}

function normalizedText(value: string): string {
  return value.trim().normalize("NFC");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function dateValue(value: unknown, label: string): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}.`);
  return date;
}

function integerValue(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`Invalid ${label}.`);
  return number;
}
