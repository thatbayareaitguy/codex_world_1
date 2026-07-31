import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { extractVersion, normalizeText } from "@radar/core";
import postgres from "postgres";
import {
  readFullWatchlistIdentitySnapshot,
  type FullWatchlistIdentitySnapshot,
} from "./itunes-full-watchlist-identity-snapshot";
import { loadLocalEnvironment } from "./local-env";

export const historicalEvidenceCutoff = "2026-07-30T02:10:30.000Z";
export const historicalEvidenceTransactionMode = "isolation level repeatable read read only";

const allowedReadTables = new Set([
  "artists",
  "artist_aliases",
  "artist_external_ids",
  "drizzle.__drizzle_migrations",
  "spotify_catalog_releases",
  "spotify_release_track_retrievals",
  "spotify_release_track_items",
  "track_external_ids",
  "tracks",
  "track_credits",
]);

export const historicalEvidenceQueries = {
  artists: `
    select
      a.id::text as canonical_artist_id,
      a.name as display_name,
      a.normalized_name,
      ae.external_id as spotify_artist_id,
      coalesce(
        (
          select array_agg(aliases.name order by aliases.normalized_name, aliases.name)
          from artist_aliases aliases
          where aliases.artist_id = a.id
            and aliases.created_at <= $2::timestamptz
        ),
        '{}'::text[]
      ) as aliases
    from artists a
    join artist_external_ids ae
      on ae.artist_id = a.id
     and ae.provider = 'spotify'
     and ae.confirmed = true
    where a.id = any(string_to_array($1, ',')::uuid[])
      and a.created_at <= $2::timestamptz
      and ae.created_at <= $2::timestamptz
      and coalesce(ae.confirmed_at, ae.imported_at, ae.created_at) <= $2::timestamptz
    order by a.normalized_name, a.id
  `,
  releases: `
    select
      catalog.artist_id::text as canonical_artist_id,
      catalog.external_release_id as spotify_release_id,
      catalog.title,
      catalog.release_date::text,
      catalog.release_date_precision,
      catalog.release_type,
      catalog.total_tracks,
      catalog.first_observed_at,
      catalog.last_observed_at,
      catalog.details_fetched_at,
      catalog.created_at,
      catalog.updated_at,
      retrieval.id::text as retrieval_id,
      retrieval.expected_total_tracks,
      retrieval.fetched_track_count,
      retrieval.status::text as retrieval_status,
      retrieval.started_at as retrieval_started_at,
      retrieval.completed_at as retrieval_completed_at,
      retrieval.discrepancy,
      retrieval.created_at as retrieval_created_at,
      retrieval.updated_at as retrieval_updated_at
    from spotify_catalog_releases catalog
    left join spotify_release_track_retrievals retrieval
      on retrieval.spotify_album_id = catalog.external_release_id
    where catalog.artist_id = any(string_to_array($1, ',')::uuid[])
      and catalog.first_observed_at <= $2::timestamptz
    order by catalog.artist_id, catalog.release_date, catalog.external_release_id
  `,
  schemaVersion: "select count(*)::int as source_schema_version from drizzle.__drizzle_migrations",
  tracks: `
    select
      catalog.artist_id::text as canonical_artist_id,
      catalog.external_release_id as spotify_release_id,
      items.provider_track_id as spotify_track_id,
      items.disc_number,
      items.track_number,
      items.first_observed_at,
      items.last_observed_at,
      external_ids.created_at as external_id_created_at,
      canonical_tracks.title,
      canonical_tracks.normalized_title,
      canonical_tracks.version,
      canonical_tracks.created_at as track_created_at,
      canonical_tracks.updated_at as track_updated_at,
      coalesce(
        array_agg(distinct credit_spotify.external_id order by credit_spotify.external_id)
          filter (
            where credits.credit_order = 0
              and credit_spotify.external_id is not null
              and credit_spotify.created_at <= $2::timestamptz
          ),
        '{}'::text[]
      ) as primary_artist_ids,
      coalesce(
        array_agg(distinct credit_spotify.external_id order by credit_spotify.external_id)
          filter (
            where credits.credit_order > 0
              and credit_spotify.external_id is not null
              and credit_spotify.created_at <= $2::timestamptz
          ),
        '{}'::text[]
      ) as feature_artist_ids
    from spotify_catalog_releases catalog
    join spotify_release_track_retrievals retrieval
      on retrieval.spotify_album_id = catalog.external_release_id
    join spotify_release_track_items items
      on items.retrieval_id = retrieval.id
    left join track_external_ids external_ids
      on external_ids.provider = 'spotify'
     and external_ids.external_id = items.provider_track_id
    left join tracks canonical_tracks
      on canonical_tracks.id = external_ids.track_id
    left join track_credits credits
      on credits.track_id = canonical_tracks.id
    left join artist_external_ids credit_spotify
      on credit_spotify.artist_id = credits.artist_id
     and credit_spotify.provider = 'spotify'
     and credit_spotify.confirmed = true
    where catalog.artist_id = any(string_to_array($1, ',')::uuid[])
      and catalog.first_observed_at <= $2::timestamptz
      and items.first_observed_at <= $2::timestamptz
    group by
      catalog.artist_id,
      catalog.external_release_id,
      items.provider_track_id,
      items.disc_number,
      items.track_number,
      items.first_observed_at,
      items.last_observed_at,
      external_ids.created_at,
      canonical_tracks.title,
      canonical_tracks.normalized_title,
      canonical_tracks.version,
      canonical_tracks.created_at,
      canonical_tracks.updated_at
    order by
      catalog.artist_id,
      catalog.external_release_id,
      items.disc_number,
      items.track_number,
      items.provider_track_id
  `,
  transactionState: `
    select
      current_setting('transaction_isolation') as isolation_level,
      current_setting('transaction_read_only') as read_only,
      now() as snapshot_timestamp
  `,
} as const;

export interface HistoricalIdentityTrack {
  discPosition: number;
  exclusionReasons: string[];
  featureArtistIds: string[];
  normalizedTitle: string;
  originalTitle: string;
  primaryCreditedArtistIds: string[];
  sourceObservationTimestamp: string;
  spotifyTrackId: string;
  trackPosition: number;
  usableForStrongIdentity: boolean;
  versionMarkers: string[];
}

export interface HistoricalIdentityRelease {
  appearanceOrFeatureArtistIds: string[];
  exclusionReasons: string[];
  normalizedTitle: string;
  originalTitle: string;
  primaryCreditedArtistIds: string[];
  releaseDate: string;
  releaseDatePrecision: string;
  releaseType: string;
  retrievalCompletenessState: string;
  sourceObservationTimestamp: string;
  spotifyReleaseId: string;
  totalTrackCount: number;
  tracks: HistoricalIdentityTrack[];
  usableForStrongIdentity: boolean;
  versionMarkers: string[];
}

export interface HistoricalIdentityArtist {
  aliases: string[];
  canonicalArtistId: string;
  displayName: string;
  normalizedName: string;
  releases: HistoricalIdentityRelease[];
  spotifyArtistId: string;
}

export interface HistoricalIdentityEvidenceSnapshot {
  artists: HistoricalIdentityArtist[];
  canonicalContentSha256: string;
  evidenceCutoff: string;
  kind: "itunes_historical_spotify_identity_evidence";
  snapshotId: string;
  snapshotTimestamp: string;
  source: {
    branch: string;
    commit: string;
    repositoryPath: string;
    schemaVersion: number;
    transactionIsolation: "repeatable read";
    transactionReadOnly: true;
  };
  summary: {
    artistCount: number;
    artistsWithUsableHistoricalEvidence: number;
    artistsWithoutUsableHistoricalEvidence: number;
    releaseCount: number;
    trackCount: number;
    usableReleaseCount: number;
    usableTrackCount: number;
  };
  version: 1;
}

export interface HistoricalEvidenceReadTransaction {
  query(statement: string, parameters?: unknown[]): Promise<unknown[]>;
}

export interface HistoricalEvidenceReader {
  transaction<T>(
    mode: string,
    work: (transaction: HistoricalEvidenceReadTransaction) => Promise<T>,
  ): Promise<T>;
}

interface RawHistoricalArtist {
  aliases: unknown;
  canonical_artist_id: string;
  display_name: string;
  normalized_name: string;
  spotify_artist_id: string;
}

interface RawHistoricalRelease {
  canonical_artist_id: string;
  created_at: Date;
  details_fetched_at: Date | null;
  discrepancy: string | null;
  expected_total_tracks: number | null;
  fetched_track_count: number | null;
  first_observed_at: Date;
  last_observed_at: Date;
  release_date: string;
  release_date_precision: string;
  release_type: string;
  retrieval_completed_at: Date | null;
  retrieval_created_at: Date | null;
  retrieval_id: string | null;
  retrieval_started_at: Date | null;
  retrieval_status: string | null;
  retrieval_updated_at: Date | null;
  spotify_release_id: string;
  title: string;
  total_tracks: number;
  updated_at: Date;
}

interface RawHistoricalTrack {
  canonical_artist_id: string;
  disc_number: number;
  external_id_created_at: Date | null;
  feature_artist_ids: unknown;
  first_observed_at: Date;
  last_observed_at: Date;
  normalized_title: string | null;
  primary_artist_ids: unknown;
  spotify_release_id: string;
  spotify_track_id: string;
  title: string | null;
  track_created_at: Date | null;
  track_number: number;
  track_updated_at: Date | null;
  version: string | null;
}

export async function exportHistoricalIdentityEvidence(input: {
  identitySnapshotPath: string;
  outputPath: string;
  sourceEnvironmentPath: string;
  sourceRepositoryPath: string;
}): Promise<{
  fileByteSha256: string;
  generationPasses: 2;
  outputPath: string;
  snapshot: HistoricalIdentityEvidenceSnapshot;
}> {
  const identity = await readFullWatchlistIdentitySnapshot(input.identitySnapshotPath);
  if (identity.artists.length !== 593) {
    throw new Error("Historical evidence export requires the frozen 593-artist identity snapshot.");
  }
  const source = sourceGitState(input.sourceRepositoryPath);
  if (!source.clean || source.ahead !== 0 || source.behind !== 0) {
    throw new Error("Historical evidence export requires a clean synchronized source worktree.");
  }
  const sourceEnvironment = loadLocalEnvironment({}, input.sourceEnvironmentPath);
  const databaseUrl = sourceEnvironment.DATABASE_URL;
  if (!databaseUrl) throw new Error("The source environment has no DATABASE_URL.");
  const sql = postgres(databaseUrl, {
    connection: { application_name: "itunes-historical-identity-evidence-readonly" },
    max: 1,
  });
  try {
    const reader: HistoricalEvidenceReader = {
      transaction: (mode, work) =>
        sql.begin(mode, async (tx) =>
          work({
            query: async (statement, parameters = []) => {
              assertHistoricalEvidenceReadOnlyStatement(statement);
              return tx.unsafe(statement, parameters as never[]);
            },
          }),
        ) as Promise<Awaited<ReturnType<typeof work>>>,
    };
    const snapshot = await collectHistoricalIdentityEvidenceFromReader(reader, {
      identity,
      sourceBranch: source.branch,
      sourceCommit: source.commit,
      sourceRepositoryPath: resolve(input.sourceRepositoryPath),
    });
    const first = serializeHistoricalIdentityEvidence(snapshot);
    const regenerated = regenerateHistoricalIdentityEvidenceSnapshot(snapshot);
    const second = serializeHistoricalIdentityEvidence(regenerated);
    if (
      first !== second ||
      snapshot.canonicalContentSha256 !== regenerated.canonicalContentSha256
    ) {
      throw new Error("Historical evidence snapshot generation was not deterministic.");
    }
    const outputPath = resolve(input.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, first, { encoding: "utf8", flag: "wx" });
    return {
      fileByteSha256: sha256(first),
      generationPasses: 2,
      outputPath,
      snapshot,
    };
  } finally {
    await sql.end();
  }
}

export async function collectHistoricalIdentityEvidenceFromReader(
  reader: HistoricalEvidenceReader,
  input: {
    identity: FullWatchlistIdentitySnapshot;
    sourceBranch: string;
    sourceCommit: string;
    sourceRepositoryPath: string;
  },
): Promise<HistoricalIdentityEvidenceSnapshot> {
  return reader.transaction(historicalEvidenceTransactionMode, (transaction) =>
    collectHistoricalIdentityEvidence(transaction, input),
  );
}

export async function collectHistoricalIdentityEvidence(
  transaction: HistoricalEvidenceReadTransaction,
  input: {
    identity: FullWatchlistIdentitySnapshot;
    sourceBranch: string;
    sourceCommit: string;
    sourceRepositoryPath: string;
  },
): Promise<HistoricalIdentityEvidenceSnapshot> {
  const cutoff = new Date(historicalEvidenceCutoff);
  const ids = input.identity.artists.map((artist) => artist.canonicalArtistId);
  const serializedIds = serializeHistoricalArtistIdSet(ids);
  const transactionRows = await guardedQuery(
    transaction,
    historicalEvidenceQueries.transactionState,
  );
  const transactionState = transactionRows[0] as
    { isolation_level?: unknown; read_only?: unknown; snapshot_timestamp?: unknown } | undefined;
  if (
    transactionState?.isolation_level !== "repeatable read" ||
    transactionState.read_only !== "on"
  ) {
    throw new Error("Historical evidence export transaction is not repeatable-read and read-only.");
  }
  const schemaRows = await guardedQuery(transaction, historicalEvidenceQueries.schemaVersion);
  const sourceSchemaVersion = integer(
    (schemaRows[0] as { source_schema_version?: unknown } | undefined)?.source_schema_version,
    "source schema version",
  );
  const artistRows = await guardedQuery(transaction, historicalEvidenceQueries.artists, [
    serializedIds,
    historicalEvidenceCutoff,
  ]);
  const releaseRows = await guardedQuery(transaction, historicalEvidenceQueries.releases, [
    serializedIds,
    historicalEvidenceCutoff,
  ]);
  const trackRows = await guardedQuery(transaction, historicalEvidenceQueries.tracks, [
    serializedIds,
    historicalEvidenceCutoff,
  ]);
  const normalizedArtists = (artistRows as RawHistoricalArtist[]).map(normalizeRawArtist);
  assertIdentityMatchesFrozen(input.identity, normalizedArtists);
  const rawTracks = (trackRows as RawHistoricalTrack[]).filter(
    (track) => date(track.first_observed_at, "track observation timestamp") <= cutoff,
  );
  const releasesByArtist = new Map<string, HistoricalIdentityRelease[]>();
  for (const rawRelease of releaseRows as RawHistoricalRelease[]) {
    if (date(rawRelease.first_observed_at, "release observation timestamp") > cutoff) continue;
    const tracks = rawTracks
      .filter(
        (track) =>
          track.canonical_artist_id === rawRelease.canonical_artist_id &&
          track.spotify_release_id === rawRelease.spotify_release_id,
      )
      .map((track) => normalizeRawTrack(track, cutoff));
    const release = normalizeRawRelease(rawRelease, tracks, cutoff);
    const list = releasesByArtist.get(rawRelease.canonical_artist_id) ?? [];
    list.push(release);
    releasesByArtist.set(rawRelease.canonical_artist_id, list);
  }
  const snapshotTimestamp = date(
    transactionState.snapshot_timestamp,
    "transaction snapshot timestamp",
  ).toISOString();
  const content = canonicalHistoricalEvidenceContent({
    artists: normalizedArtists.map((artist) => ({
      ...artist,
      releases: releasesByArtist.get(artist.canonicalArtistId) ?? [],
    })),
    evidenceCutoff: historicalEvidenceCutoff,
    kind: "itunes_historical_spotify_identity_evidence",
    snapshotId: `itunes-historical-spotify-identity-evidence-${snapshotTimestamp.replace(/[:.]/g, "-")}`,
    snapshotTimestamp,
    source: {
      branch: input.sourceBranch,
      commit: input.sourceCommit,
      repositoryPath: resolve(input.sourceRepositoryPath),
      schemaVersion: sourceSchemaVersion,
      transactionIsolation: "repeatable read",
      transactionReadOnly: true,
    },
    version: 1,
  });
  const snapshot = {
    ...content,
    canonicalContentSha256: sha256(JSON.stringify(content)),
  };
  validateHistoricalIdentityEvidence(snapshot);
  return snapshot;
}

export function serializeHistoricalArtistIdSet(ids: string[]): string {
  if (ids.length === 0) throw new Error("Historical evidence export requires artist IDs.");
  for (const id of ids) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      throw new Error(`Historical evidence export rejected an invalid artist ID: ${id}`);
    }
  }
  return ids.join(",");
}

export async function readHistoricalIdentityEvidence(
  path: string,
): Promise<HistoricalIdentityEvidenceSnapshot> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  validateHistoricalIdentityEvidence(parsed);
  return parsed;
}

export function serializeHistoricalIdentityEvidence(
  snapshot: HistoricalIdentityEvidenceSnapshot,
): string {
  validateHistoricalIdentityEvidence(snapshot);
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function validateHistoricalIdentityEvidence(
  value: unknown,
): asserts value is HistoricalIdentityEvidenceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Historical identity evidence snapshot must be an object.");
  }
  const snapshot = value as Partial<HistoricalIdentityEvidenceSnapshot>;
  if (
    snapshot.version !== 1 ||
    snapshot.kind !== "itunes_historical_spotify_identity_evidence" ||
    snapshot.evidenceCutoff !== historicalEvidenceCutoff ||
    !Array.isArray(snapshot.artists) ||
    snapshot.artists.length !== 593 ||
    !snapshot.source ||
    snapshot.source.transactionIsolation !== "repeatable read" ||
    snapshot.source.transactionReadOnly !== true
  ) {
    throw new Error("Historical identity evidence snapshot is incomplete.");
  }
  const forbidden = findForbiddenKey(snapshot);
  if (forbidden) throw new Error(`Historical evidence contains prohibited field: ${forbidden}`);
  const content = canonicalHistoricalEvidenceContent({
    artists: snapshot.artists,
    evidenceCutoff: snapshot.evidenceCutoff,
    kind: snapshot.kind,
    snapshotId: requiredText(snapshot.snapshotId, "snapshot ID"),
    snapshotTimestamp: date(snapshot.snapshotTimestamp, "snapshot timestamp").toISOString(),
    source: snapshot.source,
    version: 1,
  });
  if (
    sha256(JSON.stringify(content)) !== snapshot.canonicalContentSha256 ||
    JSON.stringify(content.artists) !== JSON.stringify(snapshot.artists) ||
    JSON.stringify(content.summary) !== JSON.stringify(snapshot.summary)
  ) {
    throw new Error("Historical evidence canonical content or hash does not match.");
  }
}

export function assertHistoricalEvidenceReadOnlyStatement(statement: string): void {
  const normalized = statement
    .replace(/--.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  if (!normalized.startsWith("select ") && !normalized.startsWith("with ")) {
    throw new Error("Historical evidence export permits SELECT statements only.");
  }
  if (
    /\b(insert|update|delete|merge|upsert|alter|create|drop|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh|lock|temporary|temp)\b/.test(
      normalized,
    ) ||
    /\bpg_(advisory|try_advisory)_/.test(normalized) ||
    /\bfor\s+(update|share|no key update|key share)\b/.test(normalized)
  ) {
    throw new Error("Historical evidence export rejected a write, lock, or DDL statement.");
  }
  const references = [...normalized.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)].map(
    (match) => match[1]!,
  );
  const disallowed = references.find((reference) => !allowedReadTables.has(reference));
  if (disallowed) {
    throw new Error(`Historical evidence query references a prohibited table: ${disallowed}`);
  }
}

export function historicalVersionMarkers(value: string): string[] {
  const normalized = normalizeText(value);
  const markers = [
    "acoustic",
    "clean",
    "demo",
    "edit",
    "extended",
    "instrumental",
    "live",
    "mix",
    "remaster",
    "remix",
    "vip",
  ].filter((marker) => new RegExp(`(^| )${marker}( |$)`).test(normalized));
  const extracted = extractVersion(value);
  return [...new Set([...(extracted ? [extracted] : []), ...markers])].sort(compareText);
}

function normalizeRawArtist(row: RawHistoricalArtist): HistoricalIdentityArtist {
  return {
    aliases: stringArray(row.aliases).map(normalizedText).sort(compareText),
    canonicalArtistId: normalizedText(row.canonical_artist_id),
    displayName: normalizedText(row.display_name),
    normalizedName: normalizedText(row.normalized_name),
    releases: [],
    spotifyArtistId: normalizedText(row.spotify_artist_id),
  };
}

function normalizeRawTrack(row: RawHistoricalTrack, cutoff: Date): HistoricalIdentityTrack {
  const exclusionReasons: string[] = [];
  if (!row.title || !row.normalized_title) exclusionReasons.push("missing_track_metadata");
  if (!row.track_created_at || row.track_created_at > cutoff) {
    exclusionReasons.push("track_metadata_not_proven_before_cutoff");
  }
  if (row.track_updated_at && row.track_updated_at > cutoff) {
    exclusionReasons.push("track_metadata_updated_after_cutoff");
  }
  if (!row.external_id_created_at || row.external_id_created_at > cutoff) {
    exclusionReasons.push("spotify_track_link_not_proven_before_cutoff");
  }
  const primary = stringArray(row.primary_artist_ids);
  if (primary.length === 0) exclusionReasons.push("missing_primary_credit");
  return {
    discPosition: row.disc_number,
    exclusionReasons: [...new Set(exclusionReasons)].sort(compareText),
    featureArtistIds: stringArray(row.feature_artist_ids).sort(compareText),
    normalizedTitle: normalizedText(row.normalized_title ?? normalizeText(row.title ?? "")),
    originalTitle: normalizedText(row.title ?? ""),
    primaryCreditedArtistIds: primary.sort(compareText),
    sourceObservationTimestamp: date(
      row.first_observed_at,
      "track observation timestamp",
    ).toISOString(),
    spotifyTrackId: normalizedText(row.spotify_track_id),
    trackPosition: row.track_number,
    usableForStrongIdentity: exclusionReasons.length === 0,
    versionMarkers: historicalVersionMarkers(`${row.title ?? ""} ${row.version ?? ""}`),
  };
}

function normalizeRawRelease(
  row: RawHistoricalRelease,
  tracks: HistoricalIdentityTrack[],
  cutoff: Date,
): HistoricalIdentityRelease {
  const exclusionReasons: string[] = [];
  if (row.updated_at > cutoff) exclusionReasons.push("catalog_state_updated_after_cutoff");
  if (!row.details_fetched_at || row.details_fetched_at > cutoff) {
    exclusionReasons.push("release_details_incomplete_at_cutoff");
  }
  if (
    row.retrieval_status !== "completed" ||
    !row.retrieval_completed_at ||
    row.retrieval_completed_at > cutoff
  ) {
    exclusionReasons.push("track_retrieval_incomplete_at_cutoff");
  }
  if (row.discrepancy)
    exclusionReasons.push(`retrieval_discrepancy:${safeReason(row.discrepancy)}`);
  if (
    row.expected_total_tracks === null ||
    row.fetched_track_count === null ||
    row.expected_total_tracks !== row.fetched_track_count ||
    row.expected_total_tracks !== tracks.length
  ) {
    exclusionReasons.push("track_count_incomplete_or_conflicting");
  }
  if (tracks.some((track) => !track.usableForStrongIdentity)) {
    exclusionReasons.push("one_or_more_tracks_excluded");
  }
  const primary = [...new Set(tracks.flatMap((track) => track.primaryCreditedArtistIds))].sort(
    compareText,
  );
  const features = [...new Set(tracks.flatMap((track) => track.featureArtistIds))].sort(
    compareText,
  );
  if (primary.length === 0) exclusionReasons.push("missing_primary_credit_evidence");
  return {
    appearanceOrFeatureArtistIds: features,
    exclusionReasons: [...new Set(exclusionReasons)].sort(compareText),
    normalizedTitle: normalizeText(row.title),
    originalTitle: normalizedText(row.title),
    primaryCreditedArtistIds: primary,
    releaseDate: row.release_date,
    releaseDatePrecision: normalizedText(row.release_date_precision),
    releaseType: normalizedText(row.release_type).toLocaleLowerCase("en-US"),
    retrievalCompletenessState: normalizedText(row.retrieval_status ?? "not_started"),
    sourceObservationTimestamp: date(
      row.first_observed_at,
      "release observation timestamp",
    ).toISOString(),
    spotifyReleaseId: normalizedText(row.spotify_release_id),
    totalTrackCount: row.total_tracks,
    tracks: [...tracks].sort(
      (left, right) =>
        left.discPosition - right.discPosition ||
        left.trackPosition - right.trackPosition ||
        compareText(left.spotifyTrackId, right.spotifyTrackId),
    ),
    usableForStrongIdentity: exclusionReasons.length === 0,
    versionMarkers: historicalVersionMarkers(row.title),
  };
}

function canonicalHistoricalEvidenceContent(input: {
  artists: HistoricalIdentityArtist[];
  evidenceCutoff: string;
  kind: "itunes_historical_spotify_identity_evidence";
  snapshotId: string;
  snapshotTimestamp: string;
  source: HistoricalIdentityEvidenceSnapshot["source"];
  version: 1;
}): Omit<HistoricalIdentityEvidenceSnapshot, "canonicalContentSha256"> {
  const artists = input.artists
    .map((artist) => ({
      aliases: [...new Set(artist.aliases.map(normalizedText))].sort(compareText),
      canonicalArtistId: normalizedText(artist.canonicalArtistId),
      displayName: normalizedText(artist.displayName),
      normalizedName: normalizedText(artist.normalizedName),
      releases: artist.releases
        .map((release) => canonicalRelease(release))
        .sort(
          (left, right) =>
            compareText(left.releaseDate, right.releaseDate) ||
            compareText(left.normalizedTitle, right.normalizedTitle) ||
            compareText(left.spotifyReleaseId, right.spotifyReleaseId),
        ),
      spotifyArtistId: normalizedText(artist.spotifyArtistId),
    }))
    .sort(
      (left, right) =>
        compareText(left.normalizedName, right.normalizedName) ||
        compareText(left.canonicalArtistId, right.canonicalArtistId),
    );
  const releases = artists.flatMap((artist) => artist.releases);
  const tracks = releases.flatMap((release) => release.tracks);
  const artistsWithEvidence = artists.filter((artist) =>
    artist.releases.some((release) => release.usableForStrongIdentity),
  ).length;
  return {
    artists,
    evidenceCutoff: date(input.evidenceCutoff, "evidence cutoff").toISOString(),
    kind: input.kind,
    snapshotId: normalizedText(input.snapshotId),
    snapshotTimestamp: date(input.snapshotTimestamp, "snapshot timestamp").toISOString(),
    source: {
      branch: normalizedText(input.source.branch),
      commit: normalizedText(input.source.commit),
      repositoryPath: resolve(input.source.repositoryPath),
      schemaVersion: input.source.schemaVersion,
      transactionIsolation: "repeatable read",
      transactionReadOnly: true,
    },
    summary: {
      artistCount: artists.length,
      artistsWithUsableHistoricalEvidence: artistsWithEvidence,
      artistsWithoutUsableHistoricalEvidence: artists.length - artistsWithEvidence,
      releaseCount: releases.length,
      trackCount: tracks.length,
      usableReleaseCount: releases.filter((release) => release.usableForStrongIdentity).length,
      usableTrackCount: tracks.filter((track) => track.usableForStrongIdentity).length,
    },
    version: 1,
  };
}

function canonicalRelease(release: HistoricalIdentityRelease): HistoricalIdentityRelease {
  return {
    appearanceOrFeatureArtistIds: [...new Set(release.appearanceOrFeatureArtistIds)].sort(
      compareText,
    ),
    exclusionReasons: [...new Set(release.exclusionReasons)].sort(compareText),
    normalizedTitle: normalizedText(release.normalizedTitle),
    originalTitle: normalizedText(release.originalTitle),
    primaryCreditedArtistIds: [...new Set(release.primaryCreditedArtistIds)].sort(compareText),
    releaseDate: release.releaseDate,
    releaseDatePrecision: normalizedText(release.releaseDatePrecision),
    releaseType: normalizedText(release.releaseType).toLocaleLowerCase("en-US"),
    retrievalCompletenessState: normalizedText(release.retrievalCompletenessState),
    sourceObservationTimestamp: date(
      release.sourceObservationTimestamp,
      "release observation timestamp",
    ).toISOString(),
    spotifyReleaseId: normalizedText(release.spotifyReleaseId),
    totalTrackCount: release.totalTrackCount,
    tracks: release.tracks
      .map((track) => ({
        discPosition: track.discPosition,
        exclusionReasons: [...new Set(track.exclusionReasons)].sort(compareText),
        featureArtistIds: [...new Set(track.featureArtistIds)].sort(compareText),
        normalizedTitle: normalizedText(track.normalizedTitle),
        originalTitle: normalizedText(track.originalTitle),
        primaryCreditedArtistIds: [...new Set(track.primaryCreditedArtistIds)].sort(compareText),
        sourceObservationTimestamp: date(
          track.sourceObservationTimestamp,
          "track observation timestamp",
        ).toISOString(),
        spotifyTrackId: normalizedText(track.spotifyTrackId),
        trackPosition: track.trackPosition,
        usableForStrongIdentity: track.usableForStrongIdentity,
        versionMarkers: [...new Set(track.versionMarkers)].sort(compareText),
      }))
      .sort(
        (left, right) =>
          left.discPosition - right.discPosition ||
          left.trackPosition - right.trackPosition ||
          compareText(left.spotifyTrackId, right.spotifyTrackId),
      ),
    usableForStrongIdentity: release.usableForStrongIdentity,
    versionMarkers: [...new Set(release.versionMarkers)].sort(compareText),
  };
}

function regenerateHistoricalIdentityEvidenceSnapshot(
  snapshot: HistoricalIdentityEvidenceSnapshot,
): HistoricalIdentityEvidenceSnapshot {
  const content = canonicalHistoricalEvidenceContent({
    artists: snapshot.artists,
    evidenceCutoff: snapshot.evidenceCutoff,
    kind: snapshot.kind,
    snapshotId: snapshot.snapshotId,
    snapshotTimestamp: snapshot.snapshotTimestamp,
    source: snapshot.source,
    version: 1,
  });
  return { ...content, canonicalContentSha256: sha256(JSON.stringify(content)) };
}

function assertIdentityMatchesFrozen(
  frozen: FullWatchlistIdentitySnapshot,
  current: HistoricalIdentityArtist[],
): void {
  if (current.length !== frozen.artists.length) {
    throw new Error("Main database identity rows do not match the frozen 593-artist snapshot.");
  }
  const byId = new Map(current.map((artist) => [artist.canonicalArtistId, artist]));
  for (const expected of frozen.artists) {
    const actual = byId.get(expected.canonicalArtistId);
    if (
      !actual ||
      actual.displayName !== expected.displayName ||
      actual.normalizedName !== expected.normalizedName ||
      actual.spotifyArtistId !== expected.spotifyArtistId ||
      JSON.stringify(actual.aliases) !==
        JSON.stringify([...expected.aliases].map(normalizedText).sort(compareText))
    ) {
      throw new Error(`Main identity differs from frozen snapshot: ${expected.canonicalArtistId}`);
    }
  }
}

async function guardedQuery(
  transaction: HistoricalEvidenceReadTransaction,
  statement: string,
  parameters: unknown[] = [],
): Promise<unknown[]> {
  assertHistoricalEvidenceReadOnlyStatement(statement);
  return transaction.query(statement, parameters);
}

function sourceGitState(path: string): {
  ahead: number;
  behind: number;
  branch: string;
  clean: boolean;
  commit: string;
} {
  const divergence = git(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    .split(/\s+/)
    .map(Number);
  return {
    ahead: divergence[0] ?? -1,
    behind: divergence[1] ?? -1,
    branch: git(path, ["branch", "--show-current"]),
    clean: git(path, ["status", "--porcelain"]) === "",
    commit: git(path, ["rev-parse", "HEAD"]),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function findForbiddenKey(value: unknown, path = ""): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = findForbiddenKey(value[index], `${path}[${index}]`);
      if (result) return result;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    if (
      /(^|_)(raw|payload|artwork|preview|credential|token|account|oauth|authorization|request_event|request_telemetry|cooldown|campaign|scheduler|lock|lease|playlist|feed|apple)(_|$)/.test(
        normalized,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const result = findForbiddenKey(child, path ? `${path}.${key}` : key);
    if (result) return result;
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map(normalizedText)
    : [];
}

function normalizedText(value: string): string {
  return value.trim().normalize("NFC");
}

function safeReason(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer.`);
  return parsed;
}

function date(value: unknown, label: string): Date {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new Error(`${label} is invalid.`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
