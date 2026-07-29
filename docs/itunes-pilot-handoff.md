# iTunes Pilot Handoff

Updated: 2026-07-29

## Repository state

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Milestone base: `484d10e5b4f436d57e934a49196b2da965b93ebf`
- Upstream at milestone start: `origin/codex/itunes-discovery`, synchronized at `0/0`
- Branch point: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Main worktree remains clean on `codex/release-radar-hardening` at
  `6c21b23ad11eae638877e20e1b3e8d6eb4b81d11`.
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

Only the identity snapshot and stage-2 dry-run plan are complete. A later live search census
requires separate authorization. Later album and recent-song discovery, Apple evidence freeze,
separate sanitized Spotify truth import, and offline evaluation also remain unexecuted.

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
