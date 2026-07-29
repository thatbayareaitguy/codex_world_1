import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import postgres from "postgres";
import { loadLocalEnvironment } from "./local-env";

export type ItunesCohortReason = "positive" | "negative" | "identity_stress";

export interface ItunesPilotSnapshotArtist {
  aliases: string[];
  canonicalArtistId: string;
  canonicalName: string;
  cohortReason: ItunesCohortReason;
  genres: string[];
  inclusionState: { active: boolean };
  normalizedName: string;
  spotifyArtistId: string;
  spotifyCoverageTimestamp: string;
}

export interface ItunesPilotSnapshotTrack {
  creditedArtists: Array<{
    canonicalArtistId: string;
    creditedName: string;
    role: string;
    spotifyArtistId?: string;
  }>;
  discNumber?: number;
  durationMs?: number;
  normalizedTitle: string;
  spotifyTrackId?: string;
  title: string;
  trackNumber?: number;
}

export interface ItunesPilotGroundTruthRelease {
  canonicalArtistId: string;
  canonicalReleaseId: string;
  completenessState?: string;
  creditedArtists: Array<{
    canonicalArtistId: string;
    creditedName: string;
    spotifyArtistId?: string;
  }>;
  feedEligible: boolean;
  normalizedTitle: string;
  releaseDate: string;
  releaseDatePrecision: string;
  releaseType: string;
  spotifyReleaseId: string;
  title: string;
  trackCount?: number;
  tracks: ItunesPilotSnapshotTrack[];
  version?: string;
}

export interface ItunesPilotSnapshot {
  artists: ItunesPilotSnapshotArtist[];
  groundTruthReleases: ItunesPilotGroundTruthRelease[];
  mainRepositoryCommit: string;
  mainSchemaVersion: number;
  snapshotHash: string;
  snapshotTimestamp: string;
  version: 1;
  windowEnd: string;
  windowStart: string;
}

interface RawArtist {
  active: boolean;
  aliases: string[] | null;
  canonical_artist_id: string;
  canonical_name: string;
  normalized_name: string;
  recent_count: number;
  recent_types: string[] | null;
  spotify_artist_id: string;
  spotify_coverage_timestamp: Date;
  stress_score: number;
}

interface RawRelease {
  canonical_artist_id: string;
  canonical_release_id: string;
  completeness_state: string | null;
  feed_eligible: boolean;
  normalized_title: string;
  release_date: string;
  release_date_precision: string;
  release_type: string;
  spotify_release_id: string;
  title: string;
  total_tracks: number | null;
  version: string | null;
}

interface RawCredit {
  canonical_artist_id: string;
  credited_artist_id: string;
  credited_name: string;
  release_id: string;
  role: string;
  spotify_artist_id: string | null;
}

interface RawTrack {
  canonical_artist_id: string;
  credited_artists: unknown;
  disc_number: number | null;
  duration_ms: number | null;
  normalized_title: string;
  release_id: string;
  spotify_track_id: string | null;
  title: string;
  track_number: number | null;
}

export async function exportItunesPilotSnapshot(input: {
  mainRepositoryCommit: string;
  outputPath: string;
  sourceEnvironmentPath: string;
}): Promise<ItunesPilotSnapshot> {
  if (!/^[0-9a-f]{40}$/i.test(input.mainRepositoryCommit)) {
    throw new Error("The main repository commit must be a full Git SHA.");
  }
  const sourceEnvironment = loadLocalEnvironment({}, input.sourceEnvironmentPath);
  const databaseUrl = sourceEnvironment.DATABASE_URL;
  if (!databaseUrl) throw new Error("The source environment has no DATABASE_URL.");
  const sql = postgres(databaseUrl, {
    max: 1,
    connection: { application_name: "release-radar-itunes-snapshot-readonly" },
  });
  try {
    const snapshot = await sql.begin("isolation level repeatable read read only", async (tx) => {
      const timestampRows = await tx<
        { snapshot_timestamp: Date }[]
      >`select now() as snapshot_timestamp`;
      const snapshotTimestamp = timestampRows[0]?.snapshot_timestamp;
      if (!snapshotTimestamp) throw new Error("Could not establish the snapshot timestamp.");
      const windowEnd = snapshotTimestamp.toISOString().slice(0, 10);
      const windowStart = new Date(snapshotTimestamp.getTime() - 60 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const schemaRows = await tx<
        { schema_version: number }[]
      >`select count(*)::int as schema_version from drizzle.__drizzle_migrations`;
      const mainSchemaVersion = schemaRows[0]?.schema_version;
      const artistRows = await tx<RawArtist[]>`
          with eligible as (
            select
              a.id as canonical_artist_id,
              a.name as canonical_name,
              a.normalized_name,
              ae.external_id as spotify_artist_id,
              greatest(
                coverage.daily_scan_completed_at,
                coverage.reconciliation_completed_at,
                coverage.last_page_scanned_at
              ) as spotify_coverage_timestamp,
              coalesce(bool_or(follows.active), false) as active,
              coalesce(
                array_agg(distinct aliases.name) filter (where aliases.name is not null),
                '{}'::text[]
              ) as aliases
            from artists a
            join artist_external_ids ae
              on ae.artist_id = a.id
             and ae.provider = 'spotify'
             and ae.confirmed = true
            join spotify_artist_coverage coverage on coverage.artist_id = a.id
            left join artist_follows follows on follows.artist_id = a.id
            left join artist_aliases aliases on aliases.artist_id = a.id
            where greatest(
              coverage.daily_scan_completed_at,
              coverage.reconciliation_completed_at,
              coverage.last_page_scanned_at
            ) is not null
            group by a.id, ae.external_id, coverage.daily_scan_completed_at,
              coverage.reconciliation_completed_at, coverage.last_page_scanned_at
          ),
          recent as (
            select
              scr.artist_id,
              count(distinct scr.external_release_id)::int as recent_count,
              array_agg(distinct scr.release_type order by scr.release_type) as recent_types
            from spotify_catalog_releases scr
            join release_external_ids rei
              on rei.provider = 'spotify'
             and rei.external_id = scr.external_release_id
            join releases r on r.id = rei.release_id
            where r.release_date between ${windowStart}::date and ${windowEnd}::date
            group by scr.artist_id
          )
          select
            eligible.*,
            coalesce(recent.recent_count, 0)::int as recent_count,
            coalesce(recent.recent_types, '{}'::text[]) as recent_types,
            (
              case when length(eligible.canonical_name) <= 5 then 3 else 0 end +
              case when eligible.canonical_name ~ '[0-9]' then 3 else 0 end +
              case when eligible.canonical_name ~ '[&+./''-]' then 2 else 0 end +
              case when eligible.canonical_name ~ '^[A-Z](\\.[A-Z])+\\.?$' then 4 else 0 end +
              case when cardinality(eligible.aliases) > 0 then 2 else 0 end +
              case when eligible.canonical_name ~* '\\m(vs|x|and)\\M' then 1 else 0 end
            )::int as stress_score
          from eligible
          left join recent on recent.artist_id = eligible.canonical_artist_id
          order by eligible.normalized_name, eligible.canonical_artist_id
        `;
      const cohort = selectCohort(artistRows);
      const cohortIds = cohort.map((artist) => artist.canonical_artist_id);
      const releaseRows = await tx<RawRelease[]>`
          select distinct
            scr.artist_id as canonical_artist_id,
            r.id as canonical_release_id,
            rei.external_id as spotify_release_id,
            r.title,
            r.normalized_title,
            r.release_date::text,
            r.release_date_precision,
            r.release_type::text,
            r.version,
            coalesce(retrieval.expected_total_tracks, scr.total_tracks) as total_tracks,
            retrieval.status::text as completeness_state,
            exists(select 1 from feed_items feed where feed.release_id = r.id) as feed_eligible
          from spotify_catalog_releases scr
          join release_external_ids rei
            on rei.provider = 'spotify'
           and rei.external_id = scr.external_release_id
          join releases r on r.id = rei.release_id
          left join spotify_release_track_retrievals retrieval
            on retrieval.spotify_album_id = rei.external_id
          where scr.artist_id in ${tx(cohortIds)}
            and r.release_date between ${windowStart}::date and ${windowEnd}::date
          order by canonical_artist_id, release_date, spotify_release_id
        `;
      const releaseIds = [...new Set(releaseRows.map((row) => row.canonical_release_id))];
      const creditRows =
        releaseIds.length === 0
          ? []
          : await tx<RawCredit[]>`
                select distinct
                  selected.artist_id as canonical_artist_id,
                  tracks.release_id,
                  credits.artist_id as credited_artist_id,
                  credits.credited_name,
                  credits.role,
                  spotify.external_id as spotify_artist_id
                from (select unnest(${cohortIds}::uuid[]) as artist_id) selected
                join spotify_catalog_releases catalog on catalog.artist_id = selected.artist_id
                join release_external_ids release_ids
                  on release_ids.provider = 'spotify'
                 and release_ids.external_id = catalog.external_release_id
                join tracks on tracks.release_id = release_ids.release_id
                join track_credits credits on credits.track_id = tracks.id
                left join artist_external_ids spotify
                  on spotify.artist_id = credits.artist_id
                 and spotify.provider = 'spotify'
                 and spotify.confirmed = true
                where tracks.release_id in ${tx(releaseIds)}
                order by tracks.release_id, credits.artist_id, credits.role
              `;
      const trackRows =
        releaseIds.length === 0
          ? []
          : await tx<RawTrack[]>`
                select distinct
                  catalog.artist_id as canonical_artist_id,
                  tracks.release_id,
                  tracks.title,
                  tracks.normalized_title,
                  tracks.duration_ms,
                  tracks.disc_number,
                  tracks.track_number,
                  spotify_track.external_id as spotify_track_id,
                  coalesce(
                    (
                      select jsonb_agg(
                        jsonb_build_object(
                          'canonicalArtistId', credits.artist_id,
                          'creditedName', credits.credited_name,
                          'role', credits.role,
                          'spotifyArtistId', spotify_artist.external_id
                        )
                        order by credits.credit_order
                      )
                      from track_credits credits
                      left join artist_external_ids spotify_artist
                        on spotify_artist.artist_id = credits.artist_id
                       and spotify_artist.provider = 'spotify'
                       and spotify_artist.confirmed = true
                      where credits.track_id = tracks.id
                    ),
                    '[]'::jsonb
                  ) as credited_artists
                from spotify_catalog_releases catalog
                join release_external_ids release_ids
                  on release_ids.provider = 'spotify'
                 and release_ids.external_id = catalog.external_release_id
                join tracks on tracks.release_id = release_ids.release_id
                left join track_external_ids spotify_track
                  on spotify_track.track_id = tracks.id
                 and spotify_track.provider = 'spotify'
                where catalog.artist_id in ${tx(cohortIds)}
                  and tracks.release_id in ${tx(releaseIds)}
                order by catalog.artist_id, tracks.release_id, tracks.disc_number, tracks.track_number
              `;
      const artists: ItunesPilotSnapshotArtist[] = cohort.map((row) => ({
        aliases: row.aliases ?? [],
        canonicalArtistId: row.canonical_artist_id,
        canonicalName: row.canonical_name,
        cohortReason: row.cohort_reason,
        genres: [],
        inclusionState: { active: row.active },
        normalizedName: row.normalized_name,
        spotifyArtistId: row.spotify_artist_id,
        spotifyCoverageTimestamp: row.spotify_coverage_timestamp.toISOString(),
      }));
      const groundTruthReleases = releaseRows.map((row) => mapRelease(row, creditRows, trackRows));
      const withoutHash = {
        artists,
        groundTruthReleases,
        mainRepositoryCommit: input.mainRepositoryCommit,
        mainSchemaVersion: mainSchemaVersion ?? 0,
        snapshotTimestamp: snapshotTimestamp.toISOString(),
        version: 1 as const,
        windowEnd,
        windowStart,
      };
      return {
        ...withoutHash,
        snapshotHash: hashSnapshot(withoutHash),
      };
    });
    validateItunesPilotSnapshot(snapshot);
    const outputPath = resolve(input.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return snapshot;
  } finally {
    await sql.end();
  }
}

export async function readItunesPilotSnapshot(path: string): Promise<ItunesPilotSnapshot> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  validateItunesPilotSnapshot(parsed);
  return parsed;
}

export function validateItunesPilotSnapshot(value: unknown): asserts value is ItunesPilotSnapshot {
  if (!value || typeof value !== "object") throw new Error("Snapshot must be an object.");
  const snapshot = value as Partial<ItunesPilotSnapshot>;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.artists)) {
    throw new Error("Unsupported iTunes pilot snapshot.");
  }
  if (snapshot.artists.length !== 50) throw new Error("Snapshot must contain exactly 50 artists.");
  const ids = new Set(snapshot.artists.map((artist) => artist.canonicalArtistId));
  if (ids.size !== 50) throw new Error("Snapshot artists must be unique.");
  const count = (reason: ItunesCohortReason) =>
    snapshot.artists!.filter((artist) => artist.cohortReason === reason).length;
  if (count("positive") !== 30 || count("negative") !== 10 || count("identity_stress") !== 10) {
    throw new Error(
      "Snapshot cohort must contain 30 positive, 10 negative, and 10 stress artists.",
    );
  }
  if (!Array.isArray(snapshot.groundTruthReleases)) {
    throw new Error("Snapshot ground-truth releases are missing.");
  }
  const forbidden = findForbiddenKey(snapshot);
  if (forbidden) throw new Error(`Snapshot contains prohibited field: ${forbidden}`);
  const { snapshotHash, ...withoutHash } = snapshot as ItunesPilotSnapshot;
  if (!snapshotHash || hashSnapshot(withoutHash) !== snapshotHash) {
    throw new Error("Snapshot hash does not match its sanitized contents.");
  }
}

function selectCohort(rows: RawArtist[]): Array<RawArtist & { cohort_reason: ItunesCohortReason }> {
  const stress = rows
    .filter((row) => row.stress_score > 0)
    .sort(
      (a, b) =>
        b.stress_score - a.stress_score ||
        a.normalized_name.localeCompare(b.normalized_name) ||
        a.canonical_artist_id.localeCompare(b.canonical_artist_id),
    )
    .slice(0, 10);
  const used = new Set(stress.map((row) => row.canonical_artist_id));
  const positive = rows
    .filter((row) => row.recent_count > 0 && !used.has(row.canonical_artist_id))
    .sort(
      (a, b) =>
        Number(b.recent_types?.includes("album")) - Number(a.recent_types?.includes("album")) ||
        b.recent_count - a.recent_count ||
        a.normalized_name.localeCompare(b.normalized_name),
    )
    .slice(0, 30);
  for (const row of positive) used.add(row.canonical_artist_id);
  const negative = rows
    .filter((row) => row.recent_count === 0 && !used.has(row.canonical_artist_id))
    .sort(
      (a, b) =>
        a.normalized_name.localeCompare(b.normalized_name) ||
        a.canonical_artist_id.localeCompare(b.canonical_artist_id),
    )
    .slice(0, 10);
  if (stress.length !== 10 || positive.length !== 30 || negative.length !== 10) {
    throw new Error("The source database cannot satisfy the required 30/10/10 cohort.");
  }
  return [
    ...positive.map((row) => ({ ...row, cohort_reason: "positive" as const })),
    ...negative.map((row) => ({ ...row, cohort_reason: "negative" as const })),
    ...stress.map((row) => ({ ...row, cohort_reason: "identity_stress" as const })),
  ];
}

function mapRelease(
  row: RawRelease,
  credits: RawCredit[],
  tracks: RawTrack[],
): ItunesPilotGroundTruthRelease {
  const releaseCredits = credits
    .filter(
      (credit) =>
        credit.release_id === row.canonical_release_id &&
        credit.canonical_artist_id === row.canonical_artist_id,
    )
    .map((credit) => ({
      canonicalArtistId: credit.credited_artist_id,
      creditedName: credit.credited_name,
      ...(credit.spotify_artist_id ? { spotifyArtistId: credit.spotify_artist_id } : {}),
    }));
  const uniqueCredits = [
    ...new Map(
      releaseCredits.map((credit) => [
        `${credit.canonicalArtistId}:${credit.creditedName}`,
        credit,
      ]),
    ).values(),
  ];
  return {
    canonicalArtistId: row.canonical_artist_id,
    canonicalReleaseId: row.canonical_release_id,
    ...(row.completeness_state ? { completenessState: row.completeness_state } : {}),
    creditedArtists: uniqueCredits,
    feedEligible: row.feed_eligible,
    normalizedTitle: row.normalized_title,
    releaseDate: row.release_date,
    releaseDatePrecision: row.release_date_precision,
    releaseType: row.release_type,
    spotifyReleaseId: row.spotify_release_id,
    title: row.title,
    ...(row.total_tracks === null ? {} : { trackCount: row.total_tracks }),
    tracks: tracks
      .filter(
        (track) =>
          track.release_id === row.canonical_release_id &&
          track.canonical_artist_id === row.canonical_artist_id,
      )
      .map((track) => {
        const creditedArtists = Array.isArray(track.credited_artists)
          ? (track.credited_artists as ItunesPilotSnapshotTrack["creditedArtists"])
          : [];
        return {
          creditedArtists,
          ...(track.disc_number === null ? {} : { discNumber: track.disc_number }),
          ...(track.duration_ms === null ? {} : { durationMs: track.duration_ms }),
          normalizedTitle: track.normalized_title,
          ...(track.spotify_track_id ? { spotifyTrackId: track.spotify_track_id } : {}),
          title: track.title,
          ...(track.track_number === null ? {} : { trackNumber: track.track_number }),
        };
      }),
    ...(row.version ? { version: row.version } : {}),
  };
}

function hashSnapshot(value: object): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLocaleLowerCase("en-US");
    if (
      /(^|_)(access_token|refresh_token|oauth|secret|credential|authorization|request_headers?|cooldown|campaign|lease|leases|playlist|personal_account)(_|$)/.test(
        normalizedKey,
      )
    ) {
      return path ? `${path}.${key}` : key;
    }
    const result = findForbiddenKey(child, path ? `${path}.${key}` : key);
    if (result) return result;
  }
  return undefined;
}
