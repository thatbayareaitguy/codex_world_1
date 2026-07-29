# iTunes Pilot Handoff

Updated: 2026-07-28

## Repository state

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Branch point: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Main worktree remains on `codex/release-radar-hardening`.
- The main worktree's pre-existing `docs/AI_HANDOFF.md` modification was not changed.

## Main Spotify safety baseline

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
- Unit tests: 316 passed in 44 files
- PostgreSQL integration: 84 passed in 15 files against `radar_itunes_test`; the final
  corrected fixture passed two complete runs from fresh schemas
- Clean and upgrade migration coverage: passed
- Migration drift: no schema changes pending after migration generation verification
- Production build: passed
- Playwright: 23 passed against the isolated test database and loopback port 3100
- Pilot doctor: `READY`; 18 migrations; isolated port 3001 available
- `git diff --check`: passed
- No live iTunes request has occurred.

## Next checkpoint

Commit and push the verified implementation. Then run plan mode with zero requests before
explicitly enabling and starting the bounded live pilot. Do not modify source code after the first
live iTunes request.
