# iTunes Pilot Handoff

Updated: 2026-07-30

## Adaptive identity-resolution milestone

The bounded live experiment executor is now under implementation. Its frozen scope is unchanged:
50 artists, 98 operations, 19 cache hits, 79 new requests, 73 album lookups, and 25 targeted album
searches. The dedicated command, gates, decision rules, canary, and external artifacts are described
in `docs/itunes-adaptive-identity-experiment.md`. No live experiment request is permitted until the
implementation passes full credential-free verification and its checkpoint is pushed and clean.

The adaptive full-watchlist identity strategy is implemented and documented in
`docs/itunes-adaptive-identity-resolution.md`.

- Repair checkpoint:
  `194e18fefee8e1ced25cd89051f1aa65ecfca7b7`
- Historical snapshot:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-historical-spotify-identity-evidence-2026-07-30T02-10-30Z.json`
- Historical snapshot file SHA-256:
  `fd35a9caab3b7ebdc52a999ecabc8e507d72e29c359323d62908de20a4a0bf33`
- Historical snapshot canonical SHA-256:
  `57966b58d5d5ce16ec8ab38a09327052c78b091ad6c3f6db27ebd2cd61b4b49d`
- Evidence counts: 593 artists, 3,935 releases, and 623 tracks.
- Strict usable anchors: 164 artists; no usable anchor: 429.
- Ambiguous artist anchors: 198 zero, 51 one, and 36 two or more.
- Brute-force baseline: 3,184 new requests.
- Album-first estimate: 2,595 requests.
- Hybrid bounds: 373 best case, 2,067 expected under explicit assumptions, and 2,946 worst case.
- Future dry-run manifest:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-adaptive-identity-experiment-plan-2026-07-30T02-10-30Z.json`
- Manifest hashes: file
  `b24b51bfbeba03c75e74ed2a59d5d7c7bff0dcadce5e12147af9c2c6413211e0`, canonical
  `271012f7cb5b8c2d95e6a59b76a51dbc67f4b76452b2dcbff342530c3869683d`.
- Future cohort: 50 artists, 98 planned operations, 19 cache hits, and 79 new requests.
- Authorized next bounded test: hybrid targeted search plus adaptive lookup through the frozen
  experiment manifest only.

The replacement main-database export ran exactly once under `REPEATABLE READ READ ONLY`. No
further main-database access or provider request occurred. `ITUNES_DISCOVERY_ENABLED=false`.
No migration was added, and `docs/AI_HANDOFF.md` was not modified. The planned experiment remains
unauthorized.

## Repository state

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Current milestone base: `bfd305149ab6776bb84a0809009ff3ecc435d5ba`
- Upstream at milestone start: `origin/codex/itunes-discovery`, synchronized at `0/0`
- Branch point: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Main worktree remains clean on `codex/release-radar-hardening` at
  `7c2b381c0795d1933c13b55914c30900b2a0f63d`.
- No original-worktree file was changed. No current Spotify operational state was inferred from
  older handoff text.

Commit `bc865ceb82f1d95b08e2838d3b59f054f5bd8ba1` is reachable from this branch. It changed only
`docs/AI_HANDOFF.md`, replacing an older main operational handoff with iTunes feature content.
This milestone does not amend or revert it and does not modify `docs/AI_HANDOFF.md`. It is an
integration-history concern because a future merge could overwrite the main branch's canonical
handoff.

## Full-watchlist census preparation

No live census was run. One authorized main-database transaction exported identity-only data under
`REPEATABLE READ READ ONLY`; the SQL path rejects writes, DDL, locks, advisory locks, and
non-identity tables. No other main-database access occurred.

- Shadow protocol: `docs/itunes-shadow-pilot-design.md`
- Snapshot:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-identity-2026-07-29T06-00-40-741Z.json`
- Active artists: 593
- Original pilot artists still present: 50 of 50
- Snapshot `fileByteSha256`:
  `f555e68c8c16ff78e4cc71e9200b6eddcbd2a7d6dc31f88f4b470d6f50357f23`
- Snapshot `canonicalContentSha256`:
  `e9967d5be4b3ddc9d75fcc7e992ea141cccaa2565d314be281ac3d266ea12040`
- Dry-run manifest:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-artist-search-census-plan-2026-07-29T06-00-40-741Z.json`
- Manifest `fileByteSha256`:
  `d808dc6c10d6b1a280abe0aff0d4676360a0c3322a4aa0fa5ffc1ef1441af815`
- Valid reusable artist-search cache rows: 50
- Invalid rows and input failures: 0
- New searches planned: 543
- Deterministic shards: 150/125, 150/145, 150/139, and 143/134, where each pair is
  artists/new searches
- Total request-start pacing floor: 28 minutes 57.6 seconds at 3200 ms per new request
- Network clients initialized by export and planning commands: 0
- Provider requests and production writes: 0

The identity snapshot and stage-2 dry-run plan are complete. The current milestone separately
authorizes the four frozen live search shards only after the implementation checkpoint passes.
Later album and recent-song discovery, Apple evidence freeze, separate sanitized Spotify truth
import, and offline evaluation remain unexecuted and unauthorized.

## Full-watchlist search-census implementation checkpoint

The dedicated `pnpm itunes:shadow:search-census` command is implemented separately from the
legacy 50-artist runner. At this pre-live stage it has made no provider request.

- `execute` accepts only one frozen shard and requires explicit live mode, exact input hashes,
  exact branch and commit, clean source, isolated `radar_itunes`, no active run or lease, exact
  planned network budget no greater than 150, runtime no greater than 15 minutes, concurrency one,
  and 3200 ms pacing.
- The command constructs `ItunesClient` behind an `ArtistSearchOnlyClient` interface exposing only
  `searchArtists`. It cannot generate album, song, collection-detail, batch, or `/lookup`
  operations.
- Cache hits create auditable request events and do not consume the persisted network budget.
  Controlled-partial resume accepts a newly cached network identity only when the same run already
  has its successful network event and terminal mapping.
- Each shard has a separate run record and one deterministic terminal mapping per processed
  artist. Structured JSONB evidence stores normalized candidates and search-stage state without
  raw payloads, artwork, previews, releases, or tracks.
- A 27-condition verifier checks exact counts and membership, duplicates, retries, HTTP and parse
  failures, 429 and Retry-After, response bounds, redirects, global pacing, overlap, search-only
  paths, provider isolation, run and lease termination, frozen hashes, source stability, and safe
  persisted shape.
- The artifact generator supports complete and controlled-partial states, fixed ordering,
  repeated deterministic generation, candidate distributions, original-cohort comparison, and a
  bounded projection for a later candidate-catalog evidence phase.
- Schema limitation: the external 593-artist identity snapshot is linked through exact paths and
  hashes in run metrics while the unchanged legacy 50-artist snapshot is used only as the required
  foreign-key anchor. No migration or fabricated legacy snapshot row is needed.
- Cache limitation: normalized cache rows still lack explicit normalizer and provider-client
  version fields. The executor records a behavior fingerprint but does not change cache
  versioning.
- Artifact hash rule: embedded canonical and file-byte hashes are calculated before either hash
  field is added. The command separately reports the SHA-256 of the exact final file bytes.

Pre-live credential-free verification:

- Formatting: passed
- Lint: passed with zero warnings
- Strict TypeScript: passed across all six packages
- Unit tests: 376 passed in 48 files
- PostgreSQL integration: 85 passed in 16 files against `radar_itunes_test`
- Initial integration invocation: stopped before tests because the isolated compose overlay had
  not been loaded and the default port 5433 was occupied; the correctly isolated rerun on port
  55434 passed completely
- Clean and upgrade migration coverage: passed
- Migration drift: no schema changes and no migration generated
- Production build: passed
- Mocked Playwright: 23 passed
- Credential-free pilot doctor: `READY`, with 18 migrations and loopback port 3001 available
- Disabled command-level refusal: passed after verifying the exact frozen snapshot and manifest
- `git diff --check`: passed
- Isolated pre-live database baseline remained 360 request events, 258 cache rows, two historical
  runs, zero active runs, and zero active request leases

## Complete full-watchlist artist-search census

The dedicated census completed all four frozen shards at execution commit
`3f83ac4189609f2171a92d4216c0bc3dbd92e140`. The detailed record is
`docs/itunes-full-watchlist-search-census.md`.

- Shard run IDs: `e44e708d-8eff-4c95-a660-6ae3f6448b32`,
  `a2845562-7c31-44af-86ae-d14cfaf8eff6`,
  `e6b380fe-23a1-4363-b250-846a0d6d5948`, and
  `0cbb85f2-e2f8-4a09-9cbe-2cb761bdf5d1`
- Completed artists: 593
- Original cache hits: 50
- New artist searches: 543
- Minimum observed per-shard request-start interval: 3201, 3201, 3202, and 3202 ms
- Retries, HTTP errors, 429s, Retry-After rows, parsing errors, response-bound errors, overlaps,
  `/lookup` events, batch events, and other-provider events: 0
- Search-stage results: 307 unique exact canonical, 0 unique alias supported, 285 competing exact
  or alias, 1 without an exact or alias candidate, 0 invalid inputs, and 0 unsafe results
- Search-stage mapping coverage: 51.8%; unresolved identity rate: 48.2%
- Normalized Apple candidates: 3,149; plausible exact or alias candidate IDs: 1,693
- Artists reaching the configured search result limit: 225
- Original cohort: all 50 included, all 50 search rows reused, 26 unique exact and 24 competing,
  with no discrepancy from prior search evidence
- Later catalog-evidence projection: 101 candidate IDs already have album cache and 101 have song
  cache; 1,592 new album plus 1,592 new song requests remain, split into 22 runs at a 2:49:48.8
  pacing floor
- Final historical request-event count: 953
- Final normalized-cache count: 801
- Active run and request lease: none
- `ITUNES_DISCOVERY_ENABLED=false`

Complete external artifact:

`C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-search-census-2026-07-30T02-10-30Z.json`

- Exact final file SHA-256:
  `ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa`
- Canonical-content SHA-256:
  `8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d`
- Search-behavior fingerprint:
  `1493cc6db2ae9e939ea6ae904f6a2625b760be96feef3a6820151126118cd4a4`

The result establishes operational feasibility for full-watchlist artist search. It justifies
preparing a separately authorized candidate-catalog evidence phase because the remaining burden
is bounded, but it does not authorize those requests or any production classification.

Full-watchlist preparation verification:

- Formatting: passed after excluding the deterministic generated offline-evaluation JSON from
  Prettier; the evidence file remained byte-identical
- Lint: passed with zero warnings
- Strict TypeScript: passed across all six packages
- Unit tests: 350 passed in 47 files
- PostgreSQL integration: 85 passed in 16 files against the isolated test database, including
  clean migrations, upgrade migrations, and the real read-only identity query
- One first integration attempt reproduced the previously documented intermittent mocked Reddit
  fixture assertion at 84 of 85; a complete fresh-database rerun passed 85 of 85 without a source
  change
- Migration drift: no schema changes and no migration generated
- Production build: passed
- Mocked Playwright: 23 passed
- Credential-free pilot doctor: `READY`, with 18 migrations and loopback port 3001 available
- `git diff --check`: passed

## Historical main Spotify observations

The following values were observed during an older pilot milestone and are retained only as
history. They are not assertions about current Spotify runtime state.

- Main app remained on `127.0.0.1:3000`.
- Main PostgreSQL remained on `127.0.0.1:5432`; its test service remained on `5433`.
- Windows task `TS New Music Radar Final Initial Spotify Sync` remained enabled and pointed to the
  original worktree.
- Observed campaign: `a68a793c-477a-4918-aab1-876fe6b5316a`, running, 100 of 292 successes, no
  active campaign or member lease.
- Observed Spotify request count: 1092; latest start `2026-07-28T22:04:25.045Z`.
- Observed cooldown: active until `2026-07-29T17:04:58.502Z`.
- Scheduler mode was disabled with no active lease. No operation or scan lease was active.
- This branch did not alter the task, database, campaign, cooldown, scheduler, or main files.

## Isolated environment

- Compose project: `codex_world_1_itunes`
- Web port: `3001`
- PostgreSQL: `radar_itunes` on `55433`
- PostgreSQL test: `radar_itunes_test` on `55434`
- Volume: `codex_world_1_itunes_radar-itunes-postgres`
- Runtime configuration: ignored `.app-runtime/itunes.env`, selected by `RADAR_ENV_FILE`
- All non-iTunes providers and playlist writes are disabled.
- No Windows task was created.

## Frozen comparison snapshot

- Path:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-pilot-2026-07-28T18-00-19.json`
- Snapshot timestamp: `2026-07-29T01:00:20.642Z`
- Window: `2026-05-30` through `2026-07-29`
- SHA-256:
  `48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a`
- Cohort: 30 positive, 10 negative, 10 identity-stress
- Frozen Spotify releases: 106
- Source schema version: 17
- No stored genres were available; none were inferred.
- Imported pilot snapshot ID: `5c7c27ec-9432-4457-8787-aa3bba582eea`

## Implementation

- Provider family: `apple_music`
- Source API: `itunes_search`
- Endpoints: exact HTTPS host allowlist for `/search` and `/lookup`
- Default state: disabled
- Request ceiling: 200
- Runtime ceiling: 30 minutes
- Concurrency: one
- Minimum request-start interval: 3200 ms
- Response bound: 5 MiB
- Persistent normalized cache and safe telemetry
- Deterministic exact, alias-evidence, ambiguous, no-match, and rejected mapping states
- Pilot-only collection, track, appearance, comparison, and batch data
- Migration: `0017_redundant_living_mummy.sql`

Artwork and preview fields are discarded. No Apple authentication, Apple Music API, MusicKit,
Feed, playback, download, feed ingestion, review-queue insertion, Spotify confirmation, or
playlist behavior exists.

## Credential-free verification to date

- Dependency installation: pinned pnpm 11.9.0 with frozen lockfile
- Formatting: passed
- Lint: passed with zero warnings
- Strict TypeScript: passed across all six packages
- Unit tests: 328 passed in 44 files
- PostgreSQL integration: 84 passed in 15 files against `radar_itunes_test`; the final
  corrected fixture passed two complete runs from fresh schemas
- Clean and upgrade migration coverage: passed
- Migration drift: no schema changes pending after migration generation verification
- Production build: passed
- Playwright: 23 passed against the isolated test database and loopback port 3100
- Pilot doctor: `READY`; 18 migrations; isolated port 3001 available
- `git diff --check`: passed
- Pre-live checkpoint: `42db979e779e82769330efba4891087184260fa6`
- The checkpoint was pushed and synchronized before the first live iTunes request.

## Live pilot result

- Run ID: `e51a57f6-2f95-4e6d-868b-f30ed43f90fd`
- Status: completed
- Stop reason: `pilot_workflow_completed`
- Runtime: 2026-07-29T01:23:16.853Z through 2026-07-29T01:29:17.489Z
- Requests: 108 of 200
- Request mix: 50 search, 26 album, 26 song, 4 batch, and 2 collection-detail
- Minimum observed request-start interval: 3201 ms
- Overlapping request pairs: 0
- HTTP errors and Retry-After rows: 0
- Largest response: 3,018,593 bytes, below the 5 MiB ceiling
- No source code changed after the first live request.

## Outcome

- Exact mappings: 26; ambiguous mappings: 24; mapping rate: 52.0%
- Frozen releases matched: 41 of 106; release recall: 38.7%
- Artist-level recall: 45.7%
- Recent 60-day iTunes candidates: 76 collections and 114 tracks
- Recent candidate precision proxy: 52.6%
- Appearance recall: 7 of 25 frozen feature releases, or 28.0%
- No tested batch size was safe.
- Projected recurring individual lookup load for 593 mapped artists: 1,186 requests and 63.3
  minutes at 3.2-second pacing
- Projected candidate artists: 433 of 593, implying a lower-bound 27.0% reduction from one
  Spotify artist-catalog request per artist

Historical first-run conclusion, now superseded: the first workflow was not reliable enough and
required the identity and matching correction documented below. The 93-day acceptance and missing
same-name catalog-evidence stage were subsequently corrected.

## Identity and matching correction

- Starting checkpoint: `d05d300645f0de412eb5a8d1323d4b3b1cb66601`
- The frozen snapshot, cohort, first run, 108 request events, and 108 normalized cache rows were
  verified unchanged before implementation.
- The first exact-confirmed group contained 52 frozen releases and matched 41, for 78.8% mapped
  release recall. All 16 exact-mapped artists with ground truth had a match.
- The 24 ambiguous artists carried 54 frozen releases across 19 ground-truth artists that the first
  run never evaluated.
- The 24 ambiguous searches contain 119 exact-name Apple IDs. The 19 ground-truth artists contain
  85 candidates, requiring 170 individual album and song requests to examine completely.
- Correction planning uses a deterministic 75-candidate ceiling, or 150 network requests. It
  covers 18 of the 19 ambiguous ground-truth artists and never partially examines the next artist.
- Search responses and the 26 first-stage selected catalogs must be cache hits. Ambiguous artists
  without frozen releases remain unresolved without unnecessary requests.
- Candidate evidence now retains catalog size, matched and conflicting releases, exact release
  titles, track-title overlap, credit compatibility, confidence, decision, and reason.
- Corrected matching treats version conflict, track-count conflict, and date differences above 30
  days as invalid. Differences above 14 days remain ambiguous. Exact titles within seven days may
  be probable, and 14-day matches additionally require equal track counts.
- The correction runner makes no batch lookup and does not use the unsafe first-run batch cache as
  identity or release evidence.
- Credential-free correction verification passed: formatting, lint with zero warnings, strict
  TypeScript across all six packages, 328 unit tests in 44 files, 84 PostgreSQL integration tests
  in 15 files, production build, and 23 Playwright tests.
- The integration suite had one transient failure in an unrelated mocked Reddit assertion. A full
  clean rerun passed all 84 tests without a source change.
- Migration generation reported no schema changes. The correction stores structured candidate
  evidence in the existing JSONB evidence field.
- The pilot doctor remained `READY` with 18 migrations and isolated loopback port 3001 available.

## Corrected live rerun

- Pre-live checkpoint: `ad817095cf47dfcfc05afa73850f005844a014cc`
- Run ID: `0f719ae6-bb42-48a0-b24c-557a0c2facb5`
- Status: `controlled_partial`
- Stop reason: `correction_candidate_budget_prioritization_complete`
- Runtime: 2026-07-29T03:00:28.529Z through 2026-07-29T03:08:57.198Z
- New requests: 150 of 150, comprising 75 album and 75 song lookups
- Cache hits: 102, comprising all 50 searches and the 26 album and 26 song lookups selected in the
  first run
- Candidate catalogs examined: 75; skipped before starting the next complete artist: 10
- Minimum request-start interval: 3201 ms; overlapping request pairs: 0
- HTTP errors, Retry-After rows, and batch requests: 0
- Largest correction response: 359,376 bytes
- No source code changed after the first correction request.

## Corrected outcome

- Mapping improved from 26 of 50, or 52.0%, to 39 of 50, or 78.0%.
- Thirteen ambiguous artists became evidence-confirmed. Eleven remain ambiguous.
- Mapped-only release recall was 73 of 94, or 77.7%, compared with 41 of 52, or 78.8%.
- Full-cohort release recall improved from 41 of 106, or 38.7%, to 73 of 106, or 68.9%.
- Full-cohort artist recall improved from 16 of 35, or 45.7%, to 29 of 35, or 82.9%.
- Seven-day recall improved from 6 of 13, or 46.2%, to 11 of 13, or 84.6%, using the same inclusive
  calendar definition.
- Corrected unmatched releases comprise 14 releases not retrieved by the tested workflow, 12
  unresolved-identity rows, 5 matcher-ambiguous rows, and 2 matcher-rejected rows. The 14 do not
  prove Apple catalog absence because lookup truncation remains possible for 10 of them.
- The previous 93-day BARELY ALIVE probable match is now invalid. No accepted corrected match
  exceeds 7, 14, or 30 days.
- Appearance recall is 12 of 25, or 48.0%; remix recall is 5 of 8, or 62.5%.
- The earlier supplemental-source classification is superseded by the leakage-safe offline
  evaluation below. The enriched cohort alone cannot classify iTunes as primary, supplemental, or
  rejected.
- The original 433-of-593 projection was invalid because it pooled a deliberately positive-heavy
  cohort. A randomized or full-watchlist Apple-only sweep is required for a reliable projection.

## Leakage-safe offline evaluation

- Milestone base before offline changes:
  `bc865ceb82f1d95b08e2838d3b59f054f5bd8ba1`
- Provider requests and production writes: 0
- Exact normalized mappings remain independent: 26 artists in every window.
- Historically reproducible evidence mappings: 12 at 7 days, 9 at 14 days, 6 at 30 days, and 0 at
  60 days.
- Target-window-assisted mappings excluded from unbiased metrics: 1 at 7 days, 4 at 14 days, 7 at
  30 days, and all 13 evidence-confirmed mappings at 60 days.
- Corrected unresolved mappings: 11 in every window.
- The 60-day snapshot contains no Spotify evidence before its target start, so no evidence-confirmed
  identity can be independently validated for that window.

Seven-day artist-level product result among 38 safely mapped artists:

- True positives: 9
- False positives: 0
- True negatives: 26
- False negatives: 3
- Candidate-artist recall: 9 of 12, or 75.0%
- Candidate-artist precision: 9 of 9, or 100.0%
- Specificity: 26 of 26, or 100.0%

Seven-day historical unresolved-identity fallback with Apple-negative suppression across all 50
artists:

- Unresolved or target-assisted artists sent to Spotify: 12
- Apple-candidate artists sent to Spotify: 9
- Deduplicated Spotify artist queries: 21
- Queries avoided: 29 of 50, or 58.0%
- Spotify-positive artists still queried: 10 of 13, or 76.9%
- Spotify-positive artists incorrectly skipped: BUNT., Vibe Chemistry, and William Black
- Unnecessary confirmation queries caused by Apple false positives: 0

The result justifies a separate randomized or full-watchlist Apple-only shadow pilot. It does not
justify production use or a source classification. Representative prevalence remains unproven.
The policy is evaluation-only and is not described as safe or production-ready.

Offline verification passed:

- Formatting and lint with zero warnings
- Strict TypeScript across all packages
- 336 unit tests in 46 files
- 84 PostgreSQL integration tests in 15 files
- No migration drift
- Production build
- 23 Playwright tests
- Credential-free doctor `READY` with 18 migrations
- Repeated artifact generation with identical hashes

Offline artifacts:

- `docs/itunes-pilot-offline-evaluation.json`
- `docs/itunes-pilot-identity-provenance.csv`
- `docs/itunes-pilot-match-review.csv`
- `docs/itunes-pilot-evaluation.md`

## Final integrity evidence

- Duplicate mappings, collection candidates, track candidates, and match identity rows: 0
- Cached artwork or preview fields: 0
- Unsafe persisted Apple store URLs: 0
- Pilot Spotify and MusicBrainz request events: 0
- Pilot feed items, non-mock release candidates, and playlist exports: 0
- First run: 108 network requests, 0 cache hits, 108 event rows, budget 200
- Corrected run: 150 network requests, 102 cache hits, 252 event rows, budget 150
- Combined: 258 network requests, 102 cache-hit events, 360 event rows, and 258 normalized cache
  rows
- The request ceiling is configurable and enforced per run against the lesser of the persisted run
  budget and client maximum. Cache hits do not consume the run network budget.
- Main worktree preflight: `codex/release-radar-hardening` at
  `6c21b23ad11eae638877e20e1b3e8d6eb4b81d11`, clean. No claim is made here about its current Spotify
  operational state.
- No original-worktree file, production database row, task, campaign, cooldown, scheduler, lease,
  playlist, or feed state was changed by the offline evaluation.
