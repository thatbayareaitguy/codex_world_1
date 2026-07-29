# AI Handoff

Updated: 2026-07-28 20:26 PDT (UTC-07:00)

This file is the canonical implementation and operational snapshot for the isolated iTunes
discovery branch. It excludes credentials, personal account data, authorization material, and raw
provider payloads. Do not replace it with the separate Spotify handoff from the original worktree.

## Repository State

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Current checkpoint: `7bc50b73f5f6216b6ca17328fd6c8956888218e2`
- Upstream: `origin/codex/itunes-discovery`, synchronized at `0/0`
- Worktree state before this handoff refresh: clean
- Current uncommitted change: only this `docs/AI_HANDOFF.md` refresh
- Branch point: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Pre-live correction checkpoint: `ad817095cf47dfcfc05afa73850f005844a014cc`
- Current status: identity workflow corrected, release matching corrected, bounded correction rerun
  completed as a controlled partial, evaluation committed and pushed, not merged

The latest nonmutating comparison found
`origin/codex/release-radar-hardening` still at the branch point. There are no current merge-tree
conflicts. A future migration-number conflict is possible if the main branch independently creates
another migration numbered `0017`.

## Scope And Decision

This branch implements an isolated, disabled-by-default iTunes Search API discovery pilot. It does
not implement the Apple Music API, MusicKit, authentication, playback, downloads, artwork use,
playlist behavior, feed ingestion, Spotify confirmation, or production scheduling.

The corrected pilot is useful only as a supplemental candidate source. It is not reliable enough
to serve as the primary discovery source and should not be merged from the current result. A
separate randomized or full-watchlist Apple-only pilot is required before making a defensible
watchlist-wide request-reduction estimate.

## Isolation And Runtime

- Compose project: `codex_world_1_itunes`
- Pilot database: `radar_itunes` on `127.0.0.1:55433`
- Pilot test database: `radar_itunes_test` on `127.0.0.1:55434`
- Optional pilot application port: `127.0.0.1:3001`
- Playwright test server port: `127.0.0.1:3100`
- Pilot database migrations: 18
- Pilot Spotify request events: 0
- Pilot MusicBrainz request events: 0
- Pilot feed items and playlist exports: 0
- Total pilot request-event rows after both live runs: 360
- Normalized response-cache rows: 258

The original Spotify worktree remains separate:

- Path: `C:\Users\taysh\Documents\Codex\codex_world_1`
- Branch: `codex/release-radar-hardening`
- HEAD: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Only local modification: its pre-existing `docs/AI_HANDOFF.md`
- Spotify request count remained 1,092 with latest start
  `2026-07-28T22:04:25.045Z`
- Windows task `TS New Music Radar Final Initial Spotify Sync` remained `Ready`, last result `0`,
  and continued to point to the original worktree

Do not modify the original worktree, Spotify database, Windows task, campaign, cooldown, or
scheduler while working from this branch.

## Frozen Pilot Input

- Snapshot ID: `5c7c27ec-9432-4457-8787-aa3bba582eea`
- Snapshot hash: `48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a`
- Snapshot timestamp: `2026-07-29T01:00:20.642Z`
- Window: `2026-05-30` through `2026-07-29`
- Cohort: 50 artists, comprising 30 positive, 10 negative, and 10 identity-stress artists
- Frozen Spotify ground truth: 106 releases across 35 artists
- Stored genres: unavailable, and none were inferred

The intentionally positive-heavy cohort is not representative of the 593-artist watchlist.

## First Live Pilot

- Run ID: `e51a57f6-2f95-4e6d-868b-f30ed43f90fd`
- Implementation checkpoint: `42db979e779e82769330efba4891087184260fa6`
- Status: `completed`
- Requests: 108 of 200
- Request mix: 50 artist searches, 26 album lookups, 26 song lookups, 4 unsafe batch experiments,
  and 2 collection-detail lookups
- Minimum request-start interval: 3201 ms
- Overlapping request pairs: 0
- HTTP errors and Retry-After rows: 0
- Mapping: 26 exact-confirmed and 24 ambiguous, or 52.0%
- Full release recall: 41 of 106, or 38.7%
- Full artist recall: 16 of 35, or 45.7%
- Mapped-only release recall: 41 of 52, or 78.8%
- Appearance recall: 7 of 25, or 28.0%

All 24 ambiguities were caused by multiple exact normalized artist-name candidates. The 19
ambiguous artists with frozen releases contained 85 candidate Apple artist IDs and required 170
individual catalog requests for complete examination. The first matcher also incorrectly accepted
BARELY ALIVE's `100% NO AI` releases despite a 93-day date difference.

Batch sizes 5 and 10 were unsafe. Album batches omitted results, and song batches could preserve
result counts while misattributing artists. Never use the stored batch responses as identity or
release evidence and do not use batching in an operational projection.

## Identity Resolution And Matching Correction

The deterministic second-stage resolver:

- Starts only from exact normalized same-name candidates
- Loads each candidate through separate individual album and song lookups
- Compares frozen release titles, track-title overlap, release dates, track counts, version markers,
  and artist-credit IDs
- Confirms only one uniquely strong candidate with no conflicting evidence and a score margin of at
  least two over every competitor
- Persists structured candidate evidence in the existing JSONB evidence field
- Does not use genre, popularity, search rank, response order, or batch results

Release matching now:

- Keeps original, remix, live, and studio versions distinct
- Marks version conflicts and track-count conflicts invalid
- Marks date differences above 30 days invalid without track-level proof
- Keeps differences above 14 days ambiguous
- Accepts exact normalized titles within seven days as probable
- Requires matching track counts for exact-title differences of 8 through 14 days
- Requires matching track counts and at most a one-day difference for base-title or contained-title
  probable matches

The correction runner has a 75-candidate ceiling, equal to 150 new individual requests. It never
partially examines the next artist after the complete-artist budget would be exceeded.

## Corrected Live Rerun

- Run ID: `0f719ae6-bb42-48a0-b24c-557a0c2facb5`
- Implementation checkpoint: `ad817095cf47dfcfc05afa73850f005844a014cc`
- Status: `controlled_partial`
- Stop reason: `correction_candidate_budget_prioritization_complete`
- Runtime: `2026-07-29T03:00:28.529Z` through `2026-07-29T03:08:57.198Z`
- New network requests: 150, comprising 75 album and 75 song lookups
- Cache hits: 102, comprising all 50 searches plus the first run's 26 album and 26 song lookups
- Candidate catalogs examined completely: 75
- Candidate catalogs skipped before starting the next artist: 10
- Batch requests: 0
- Minimum request-start interval: 3201 ms
- Overlapping request pairs: 0
- HTTP errors and Retry-After rows: 0
- Largest response: 359,376 bytes
- Source changes after the first correction request: none

`controlled_partial` is the expected deterministic budget result, not a provider or data-integrity
failure.

## Corrected Results

| Measure                    |   First pilot | Corrected rerun |
| -------------------------- | ------------: | --------------: |
| Exact-confirmed artists    |            26 |              26 |
| Evidence-confirmed artists |             0 |              13 |
| Ambiguous artists          |            24 |              11 |
| Mapping rate               |         52.0% |           78.0% |
| Mapped-release recall      |  41/52, 78.8% |    73/94, 77.7% |
| Full release recall        | 41/106, 38.7% |   73/106, 68.9% |
| Mapped-artist recall       | 16/16, 100.0% |   29/29, 100.0% |
| Full artist recall         |  16/35, 45.7% |    29/35, 82.9% |

Inclusive calendar-window recall:

- 7 days: 6 of 13, or 46.2%, improved to 11 of 13, or 84.6%
- 14 days: 12 of 28, or 42.9%, improved to 23 of 28, or 82.1%
- 30 days: 21 of 53, or 39.6%, improved to 36 of 53, or 67.9%
- 60 days: 41 of 106, or 38.7%, improved to 73 of 106, or 68.9%

Corrected frozen release-type recall:

- Singles: 48 of 58, or 82.8%
- EPs: 4 of 10, or 40.0%
- Albums: 4 of 5, or 80.0%
- Remixes: 5 of 8, or 62.5%
- Features or credited appearances: 12 of 25, or 48.0%
- Live and compilation releases: not measurable because the snapshot contains none

Corrected match classifications:

- Exact matches: 5
- Strong probable matches: 68
- Ambiguous matches: 5
- Invalid matches: 2
- Genuine catalog misses: 14
- Mapping-caused misses: 12
- Matcher-caused misses: 7, comprising 5 ambiguous and 2 invalid matches
- Accepted matches above 7, 14, or 30 days: 0

The previous 93-day `100% NO AI` probable match is now `invalid_match`. This fixes the known false
acceptance, but the other 73 accepted pairs do not have independent human labels, so do not claim a
general false-match rate.

## Operational Projection

- Minimum one-time mapping cost for 593 artists: 593 artist searches, plus unresolved identity
  evidence requests
- Full weekly individual lookup cost: 1,186 requests
- Full weekly runtime at 3.2-second pacing: about 63.3 minutes
- Scaling the observed 78.0% mapping rate would cover about 463 artists, cost about 926 weekly
  requests, and take about 49.4 minutes while leaving the other artists undiscovered
- No unsafe batch result is used in these estimates

The original 433-of-593 projection is invalid because it pooled mapped artists from a deliberately
positive-heavy cohort. Seven-day candidate prevalence ranged from 0.0% in the small negative group,
to 10.0% in the identity-stress group, to 46.7% in the enriched positive group. A reliable
candidate-volume and Spotify-request-reduction estimate requires randomized or full-watchlist
Apple-only sampling.

## Verification

- Formatting: passed
- Lint: passed with zero warnings
- Strict TypeScript: passed across all six packages
- Unit tests: 328 passed in 44 files
- PostgreSQL integration: 84 passed in 15 files
- Production build: passed
- Playwright: 23 passed
- Migration drift: no schema changes pending
- Pilot doctor: `READY`, 18 migrations, isolated port 3001 available
- `git diff --check`: passed

One unrelated mocked Reddit integration assertion failed transiently. A complete rerun passed all
84 integration tests without any source change.

## Changed Areas

The correction milestone changed:

- `apps/scanner/src/itunes-pilot-cli.ts`
- `apps/scanner/src/itunes-pilot-correction-runner.ts`
- `apps/scanner/src/itunes-pilot-repository.ts`
- `apps/scanner/src/itunes-pilot-runner.ts`
- `packages/core/src/itunes-pilot.ts`
- `packages/core/src/itunes-pilot.test.ts`
- `packages/providers/src/itunes.test.ts`
- `docs/itunes-pilot-design.md`
- `docs/itunes-pilot-evaluation.md`
- `docs/itunes-pilot-handoff.md`
- This canonical `docs/AI_HANDOFF.md`

No schema migration was added by the correction. The branch's initial pilot migration remains
`packages/db/drizzle/0017_redundant_living_mummy.sql`.

## Source Documents

- Detailed evaluation: `docs/itunes-pilot-evaluation.md`
- Pilot-specific design: `docs/itunes-pilot-design.md`
- Pilot execution handoff: `docs/itunes-pilot-handoff.md`
- Canonical branch handoff: `docs/AI_HANDOFF.md`

## Next Step And Guardrails

- Keep this branch unmerged unless the user authorizes a separate integration milestone.
- Do not run another live iTunes request from the completed correction plan.
- Do not reuse unsafe batch responses.
- Do not change the frozen snapshot when comparing these two runs.
- Do not infer genre performance from this snapshot.
- Do not claim Apple approval or a stable production allowance. The official iTunes documentation
  is archived and describes an approximate allowance.
- If further evaluation is authorized, create a separate representative pilot using randomized or
  full-watchlist Apple-only sampling with new explicit request and runtime limits.
- Preserve provider namespacing and never use Spotify content to identify, enrich, illustrate, or
  transfer data to Apple.
- Continue to keep all non-iTunes providers disabled in pilot mode.
