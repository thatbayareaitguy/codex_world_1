# Full-Watchlist iTunes Shadow Pilot Design

Prepared: 2026-07-29

## Status and authorization boundary

This document predeclares a prospective full-watchlist shadow evaluation. The identity-only
snapshot, offline plan, and dedicated search-census executor are implemented. No census request
had been made at the pre-live implementation checkpoint. Live execution remains gated by the
credential-free verification, clean pushed checkpoint, isolated runtime enablement, and shard-1
canary described below.

The completed 50-artist pilot remains evidence about that deliberately enriched cohort only. It
does not establish full-watchlist mapping coverage, Apple-candidate prevalence, or a production
suppression policy.

## Prepared artifacts

- Identity snapshot:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-identity-2026-07-29T06-00-40-741Z.json`
- Snapshot ID: `itunes-full-watchlist-identity-2026-07-29T06-00-40-741Z`
- Snapshot timestamp: `2026-07-29T06:00:40.741Z`
- Source schema version: 17
- Active artists: 593
- Snapshot `fileByteSha256`:
  `f555e68c8c16ff78e4cc71e9200b6eddcbd2a7d6dc31f88f4b470d6f50357f23`
- Snapshot `canonicalContentSha256`:
  `e9967d5be4b3ddc9d75fcc7e992ea141cccaa2565d314be281ac3d266ea12040`
- Search census manifest:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-artist-search-census-plan-2026-07-29T06-00-40-741Z.json`
- Manifest `fileByteSha256`:
  `d808dc6c10d6b1a280abe0aff0d4676360a0c3322a4aa0fa5ffc1ef1441af815`

The current count happens to equal the historical estimate of 593. The exporter always preserves
the actual active population and does not add or remove artists to force that number. All 50
artists from the original pilot snapshot are present.

## Identity snapshot contract

Each artist row contains only:

- canonical internal artist ID
- display name
- normalized display name
- `active: true`
- stored aliases
- confirmed Spotify artist ID used only as a stable cross-artifact identity

The snapshot envelope contains its version, snapshot ID, snapshot timestamp, source schema version,
artists, and `canonicalContentSha256`. It excludes releases, tracks, titles, dates, credentials,
tokens, accounts, request telemetry, campaigns, schedulers, cooldowns, leases, locks, playlists,
feeds, and raw provider payloads.

The source query reads only `artists`, `artist_follows`, `artist_aliases`,
`artist_external_ids`, and `drizzle.__drizzle_migrations`. It requires an active follow and one
confirmed Spotify mapping. The one authorized main-database export ran inside PostgreSQL
`REPEATABLE READ READ ONLY`. The export path rejects non-SELECT statements, write and DDL verbs,
row locks, advisory locks, and any table outside that allowlist.

### Hash and serialization rules

`canonicalContentSha256` hashes compact UTF-8 JSON containing `artists`, `snapshotId`,
`snapshotTimestamp`, `sourceSchemaVersion`, and `version`. It excludes both hash fields:
`canonicalContentSha256` is not present in the hashed content, and `fileByteSha256` is external
metadata rather than a snapshot field.

Before canonical hashing:

- strings are trimmed and normalized to Unicode NFC
- aliases are deduplicated and sorted by Unicode code-point order
- artists are sorted by normalized name and then canonical artist ID
- object keys use the fixed order emitted by the exporter
- timestamps use UTC ISO 8601 form

`fileByteSha256` hashes the exact final indented UTF-8 file, including its trailing newline and
embedded `canonicalContentSha256`. It is deliberately distinct from the canonical-content hash.

## Prospective stage separation

The later shadow pilot must preserve these seven stages:

1. Full-watchlist identity snapshot. Use the prepared identity-only artifact.
2. Apple artist-search census. Run only deterministic search shards after separate authorization.
3. Historical-evidence identity resolution. Resolve exact names and aliases without target-window
   release truth.
4. Apple album and recent-song catalog sweep. Use individual lookups only and record result-bound
   truncation.
5. Freeze Apple results. Hash and close the Apple evidence before importing target-window truth.
6. Import a separately generated sanitized Spotify ground-truth snapshot. The iTunes branch must
   never make those Spotify requests.
7. Offline evaluation. Join the two frozen artifacts by canonical identity and compute every
   predeclared policy.

Stage 1 and dry-run planning for stage 2 are complete. The dedicated stage-2 executor is
implemented. This milestone authorizes its four frozen search-only shards only after the pre-live
checkpoint passes. Stages 3 through 7 remain outside this milestone.

## Leakage prevention

- Target-window Spotify releases must not influence the Apple mapping scored for that window.
- An evidence-confirmed Apple identity may use stored aliases or Spotify evidence strictly before
  the target-window start.
- Exact normalized identity remains independent only when the Apple result is unique.
- Unresolved and ambiguous artists remain unresolved. They are never force-mapped by rank,
  popularity, genre, partial spelling, or future truth.
- Apple catalog results must be frozen before target-window Spotify truth is imported.
- The later Spotify truth must arrive as a separate sanitized comparison artifact generated
  outside this branch.
- No Apple batch lookup is permitted.
- Album and recent-song result bounds must be recorded separately. A bound hit is truncation, not
  proof of catalog completeness.
- Apple absence must not be claimed when a lookup was truncated or completeness is unknown.
- Production Spotify scans continue independently. The shadow pilot must not alter their task,
  campaign, scheduler, cooldown, lease, database, or provider client.

Seven days is the primary product window. Fourteen and 30 days are secondary measurements. Sixty
days is not a primary weekly-product decision because the original holdout had no historical
evidence before its 60-day start for any evidence-confirmed mapping.

## Predeclared product-policy simulations

These policies are fixed before full-watchlist truth is available. Results may compare them, but
future truth must not be used to tune their definitions.

### Candidate-priority policy

Prioritize Apple-candidate artists and unresolved Apple identities. Apple-negative artists remain
eligible for a later Spotify sweep. This is scheduling priority, not permanent suppression.

### Unresolved-fallback hard-filter simulation

Query Apple-candidate artists and unresolved identities. Skip safely mapped Apple-negative artists.
This is evaluation-only and must not be described as safe or production-ready.

### Unresolved-or-truncated fallback simulation

Query Apple-candidate artists, unresolved identities, artists whose album or song lookup reached a
known bound, and artists whose Apple catalog completeness cannot be established. Skip only safely
mapped, nontruncated Apple-negative artists.

### Full Spotify baseline

Query every active watchlist artist.

For every policy, the later evaluator must report:

- total Spotify artist queries, queries avoided, and percentage reduction
- positive artists queried and positive artists skipped
- releases attached to skipped positive artists
- unnecessary queries caused by Apple-candidate false positives
- unresolved-identity and truncation-fallback burdens
- raw artist names for every false negative
- candidate-artist recall and precision with raw numerators and denominators
- confidence intervals whenever a result is sample-based

The precise name for the previously described fallback is
`unresolved-identity fallback with Apple-negative suppression`. No policy is authorized for
production suppression.

## Offline search-census plan

The network-incapable planner imports no provider client. It reads the identity snapshot and the
isolated `radar_itunes` normalized response cache, then writes a search-only manifest.

- Fixed storefront: US
- Entity: `musicArtist`
- Media: `music`
- Language: `en_us`
- Result limit: 10
- Search term behavior: trimmed canonical display name from the NFC-normalized snapshot
- Total artists: 593
- Valid reusable artist-search cache rows: 50
- Invalid cache rows: 0
- Input validation failures: 0
- New searches required: 543
- Total pacing floor at 3200 ms per new request: 1,737,600 ms, or 28 minutes 57.6 seconds
- Shards: 4

| Shard | Artists | Valid cache hits | New searches | Pacing floor |
| ----: | ------: | ---------------: | -----------: | -----------: |
|     1 |     150 |               25 |          125 |       6:40.0 |
|     2 |     150 |                5 |          145 |       7:44.0 |
|     3 |     150 |               11 |          139 |       7:24.8 |
|     4 |     143 |                9 |          134 |       7:08.8 |

Every artist appears once. Membership is determined by normalized name and canonical ID, then
fixed 150-artist slices. No shard exceeds 150 artists or 150 new requests. The current configurable
per-run ceiling supports every shard at a 150-request run budget without changing provider-client
behavior.

The current cache identity includes storefront, entity, explicit setting, language, limit, media,
and the exact encoded search term. It therefore does not reuse across a different storefront or
term. It does not carry an explicit search-normalization version or provider-client version. A
future change to normalization or response interpretation could therefore reuse stale rows unless
the cache namespace or identity is versioned. The prepared manifest has no duplicate cache-key
group, so this snapshot has no current same-key artist collision.

Historical `responseHash` values were calculated before PostgreSQL `jsonb` storage. Since `jsonb`
does not preserve original object-key byte order, that byte hash cannot be reconstructed from a
retrieved row. Cache usability is therefore determined the same way as the live cache read:
well-formed hash metadata plus valid normalized response structure. Raw responses are not copied
into the manifest.

## Dedicated search-census executor

`pnpm itunes:shadow:search-census` is separate from the legacy 50-artist pilot runner. Its
compile-time client boundary exposes only `searchArtists`; it never calls or imports the legacy
runner. The command has three modes:

- `execute` requires the exact snapshot and manifest paths and hashes, shard number, explicit
  `--live`, exact branch and execution commit, exact shard network budget, and a runtime ceiling.
- `verify` evaluates a completed shard against 27 deterministic integrity conditions.
- `artifact` reconstructs a complete or controlled-partial external result from the frozen inputs
  and existing pilot tables, generates it twice, and requires byte-identical output and identical
  canonical hashes.

Each shard receives its own `itunes_pilot_runs` row. One terminal mapping row per artist stores
only normalized candidate IDs and names plus structured search-stage evidence. The evidence
records identity linkage, aliases through the frozen snapshot, search identity, cache provenance,
candidate counts, mapping state, reason, shard, run, and terminal state. Raw Apple payloads,
artwork, previews, releases, and tracks are not stored.

The existing schema cannot attach the external 593-artist snapshot directly because the snapshot
tables require the legacy cohort and release shape. Without a migration, census runs therefore
use the unchanged 50-artist pilot snapshot only as a foreign-key anchor. The exact external
snapshot and manifest paths and hashes are stored in run metrics. The complete census is
deterministically reconstructed by joining those immutable artifacts to per-run mapping and
request-event rows. No legacy snapshot artist or release row is fabricated or changed.

Controlled-partial runs can resume only from the same branch, commit, frozen inputs, and search
behavior fingerprint. Newly cached network results from the same partial run are accepted only
when both their successful network event and terminal artist mapping already exist. Completed
artists are skipped, and completed shards are rejected as idempotent no-ops.

The result artifact sorts artists by normalized name and canonical ID. Its
`canonicalContentSha256` hashes compact JSON before either hash field is added.
`fileByteSha256` hashes the indented, newline-terminated preimage before either hash field is
added. The command also reports `actualFileByteSha256`, which hashes the final file containing
both embedded hash fields. These exclusions avoid an impossible self-referential file hash.

## Live-census runbook

This is the mandatory execution checklist for the separately authorized live phase.

1. Require the exact snapshot and manifest paths and hashes listed above.
2. Verify both file-byte hashes and the snapshot canonical-content hash before creating any run.
3. Confirm branch, committed implementation checkpoint, clean worktree, isolated database, disabled
   non-iTunes providers, no active pilot run, and no active request lease.
4. Execute shards in order 1, 2, 3, 4. Create a separate persisted run record for each shard.
5. Set each run budget to its manifest new-search count, never above 150.
6. Use concurrency one, at least 3200 ms between request starts, US storefront, and required cache
   reuse.
7. Permit `/search` with `musicArtist` only. Do not permit album, song, collection-detail, lookup,
   or batch requests.
8. Make no source change after a shard begins.
9. After each shard, verify exact artist membership, cache hits, network count, one event per
   attempted item, request serialization, pacing, response validity, run termination, and released
   lease.
10. After all shards, require exactly 593 classified artists, exactly 50 planned reusable cache
    hits unless a separately explained valid cache-state change occurred, no duplicate or missing
    artist, and no non-search request.

Stop before or during a shard on:

- snapshot or request-manifest mismatch
- request-budget or runtime exhaustion
- worktree, database, or environment isolation failure
- duplicate, missing, malformed, or otherwise inconsistent evidence
- an unexpected provider host or path
- HTTP 429 requiring delay beyond the authorized shard
- any attempt to access Spotify or another provider

No album, song, collection-detail, batch, or `/lookup` request is authorized by this document.

## Evidence levels

- Implemented: identity-only exporter, SQL allowlist, snapshot validation, hash separation,
  deterministic search planner, manifest validation, dedicated search-only census executor,
  resume controls, canary verifier, and deterministic artifact generator.
- Credential-free tested: focused unit and isolated-PostgreSQL tests plus the repository-wide
  verification recorded in `docs/itunes-pilot-handoff.md`.
- Live iTunes tested: only the completed original and corrected 50-artist pilot.
- Proven on the original cohort: the historical request, mapping, matching, and offline-evaluation
  measurements in the existing pilot documents.
- Prepared for a full-watchlist census: 593-artist identity snapshot, 50 cache hits, 543 planned
  searches, four deterministic shards, and a separate search-only command.
- Proven on a full watchlist: nothing yet. The search census and later catalog evaluation have not
  run.
