# AI Handoff

Updated: 2026-07-22 18:38 PDT (UTC-07:00)

This is the canonical current implementation and operational snapshot. Design and milestone
documents may retain historical status language.

## Repository State

- Branch: `codex/release-radar-hardening`.
- HEAD and upstream: `d5e3ffb44f84d104ca3f4a1f60f852f3ad910bd6`; ahead/behind `0/0` before this handoff edit.
- Worktree: `docs/AI_HANDOFF.md` is the only expected modification from this update.
- Scheduler implementation: `9d2742dabad4aaed28b5cf365ef5e92162d86db6`.
- Current milestone: the proposed 100-artist initial-sync run is **blocked before live execution**.
  The current scheduler cannot atomically prevent a 101st first-successful scan.

## Architecture

- TypeScript pnpm monorepo: Next.js web/API in `apps/web`, short-lived scanner and operations
  commands in `apps/scanner`, provider-neutral matching in `packages/core`, Drizzle/PostgreSQL in
  `packages/db`, validated adapters in `packages/providers`, and fixtures in `packages/testing`.
- PostgreSQL is authoritative for canonical artists, provider mappings, releases, tracks,
  appearances, evidence, feed state, cursors, cooldowns, request telemetry, locks, and scheduler
  work.
- Spotify, MusicBrainz, and mock execution are isolated behind provider interfaces and independent
  request gates. Canonical matching remains provider-neutral and evidence-backed.
- The Spotify scheduler uses durable typed work, due times, expiring leases, the global operation
  lock, one PostgreSQL-backed request gate, persistent cooldowns, and short-lived one-work ticks.
- Spotify playlist export is a separate default-disabled, add-only path restricted to one
  server-configured owned private playlist. It is not part of discovery scheduling.

## Database And Operations

- Status: **verified operational**. Doctor reports `READY`; the app responds on
  `http://127.0.0.1:3000`; PostgreSQL is available.
- Migrations: 15 forward migrations through `0014_parallel_quasar.sql`.
- Watchlist: 593 active artists, all 593 with confirmed Spotify mappings; 101 have successful
  Spotify coverage and 492 remain never scanned successfully.
- Canonical data: 94 releases, 187 tracks, 205 appearances, 205 candidates, 205 evidence rows,
  205 feed rows, and 94 Spotify artwork records.
- Album integrity: 94 complete, 0 incomplete, 0 missing cursors, and 0 track-count discrepancies.
- Scheduler: database mode `disabled`; 593 base items queued, 99 reconciliation items queued,
  1 release-detail item completed, 0 blocked, and 0 active leases.
- Spotify: 501 request events; no active cooldown or request lease. The preserved historical
  cooldown expired at `2026-07-22T04:05:30.437Z`.
- Locks: 0 operation locks and 0 scan locks. No matching Windows scheduled task is registered.
- Batch 3: `pending`, with 15 pending artists and 0 batch-attributed requests.
- Latest backup: `ts-new-music-radar-2026-07-23T00-50-01-467Z.dump`, stored outside the repository.
- Blocked-run verification: no new backup, Windows task, canary tick, provider request, scheduler
  mutation, or Batch 3 mutation was started. Counts remain 101 scanned and 492 never scanned.

## Verified Capabilities

- **Verified live:** Spotify OAuth/account connection, followed-artist persistence, bounded
  artist-catalog discovery, durable scheduler base work, release-detail follow-up, canonical
  persistence, artwork persistence, evidence/feed creation, restart/resume, cooldown checks, and
  globally serialized request starts.
- **Bounded live scheduler result:** 10 natural base artists plus 1 related detail tick; 12 HTTP
  starts, all 200; 10.011-second minimum interval; no overlap, 429, cooldown, playlist request,
  other-provider request, duplicate, stranded lease, or lock.
- **Verified live persistence:** the validation created 1 release, track, appearance, candidate,
  evidence row, feed row, and artwork row. All integrity checks remained clean.
- **Verified by tests and prior UI validation:** canonical matching, source evidence, watchlist,
  feed and review state, scan history, Spotify import, manual artist management, and idempotent
  persistence.
- **Verified operational safeguards:** playlist writes, Reddit, automatic scheduler execution,
  and manual SoundCloud links all remain disabled by default.

## Implemented, Partially Verified

- **Partially verified:** rolling Spotify scheduling. Base and detail work are live-validated;
  release-track interruption/resume, reconciliation selection, pause behavior, rolling ceilings,
  and scale behavior are credential-free tested but were not exercised by this live sample.
- **Partially verified:** MusicBrainz mapping/discovery and its independent 1-second database gate
  are implemented and tested. No MusicBrainz request was made during the scheduler validation.
- **Implemented, not activated:** the one-tick PowerShell launcher. No recurring Windows task is
  registered, and automatic database/environment capabilities remain disabled.
- **Not implemented:** a durable bounded-sync campaign containing the baseline unscanned artist
  set, qualifying-success counter, target count, and atomic claim guard.
- **Implemented, not live-write verified:** add-only Spotify playlist export safeguards. Writes
  remain disabled and no allowed playlist is configured.
- **Implemented, blocked:** Reddit evidence adapter and local parsing. Live access requires explicit
  Reddit approval and compatible free access.
- **Implemented, disabled:** safe manual SoundCloud outbound links. No SoundCloud API or page
  request exists.

## Validation Evidence

- Scheduler implementation checkpoint: format, lint, strict typecheck, production build, 273 unit
  tests in 38 files, 72 PostgreSQL integration tests in 13 files, and 23 Playwright tests passed.
- Live-validation checkpoint: 29 focused unit tests in 5 files and 26 focused PostgreSQL
  integration tests in 3 files passed with no relevant skips.
- Blocked 100-artist preflight rerun: the same 29 focused unit tests and 26 focused PostgreSQL
  integration tests passed. The tests confirm existing tick safeguards but do not provide an
  exact-100 cross-tick campaign boundary.
- Initial and final scheduler plan checks started zero provider requests, claimed no lease, and made
  no domain mutation.

## Blockers, Risks, And Known Defects

- Spotify Development Mode limits are unpublished. Ten-second pacing passed this bounded sample
  but is not proof of full-watchlist or long-running reliability.
- Automatic execution is intentionally unavailable until a separate activation milestone registers
  and validates an external launcher, monitoring, pause behavior, and rollback.
- The initial synchronization is incomplete: 492 mapped artists have no successful Spotify scan.
- The scheduler can enforce one artist per tick but cannot enforce exactly 100 first-successful
  artists across independent ticks. `spotify_scheduler_state.cycle_target_artists` describes the
  whole eligible cycle, not a milestone cohort or completion boundary. The existing PowerShell
  launcher only invokes one tick and does not supervise a durable milestone counter. External
  polling would leave a race in which a 101st artist could be claimed.
- The 24-hour scheduler window is centralized but not runtime configurable.
- `docs/architecture.md` and `docs/spotify-rolling-scheduler-design.md` still contain historical
  text saying the scheduler is not live-provider tested; this file supersedes that status.
- Spotify cross-service policy language remains broad. No mixed playback, cross-provider artwork,
  or automated SoundCloud integration is permitted.

## Immediate Next Step

Run a separate credential-free implementation milestone for bounded synchronization campaigns.
Add a forward migration and transactional repository that snapshots the authorized baseline artist
set, records qualifying first successes, atomically blocks base claims at the target, allows only
campaign-created detail/track work to drain, and exposes safe status. Add unit, PostgreSQL, launcher,
restart, race, cooldown, and exact-100 boundary tests before requesting live authorization again.

## Explicitly Deferred

- Remaining 492-artist initial synchronization and all Batch 3 execution.
- The first-10 canary and temporary Windows task from the blocked 100-artist milestone.
- Production-scale scheduler claims, faster request pacing, and automatic reconciliation cadence.
- Spotify playlist writes until separately authorized and configured.
- Reddit live access until approval is recorded and free compatible access is confirmed.
- YouTube, SoundCloud API/OAuth/playlists, Apple Music, TIDAL, playback, notifications, multi-user
  support, cloud infrastructure, and commercial deployment.
