# AI Handoff

Updated: 2026-08-07 21:35 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Current checkpoint: `HEAD` (`feat: complete recurring discovery scheduler`), with parent
  `656f5769f71bf3950f48cd7c55a60a77b41a270e`
- Current milestone: recurring Thursday/Friday Apple discovery and Saturday-Wednesday Spotify
  reconciliation scheduler, completed
- Upstream: `origin/codex/release-radar-hardening` matches this checkpoint
- Worktree: clean except for unrelated untracked `outputs/`
- PostgreSQL: healthy with 27 forward migrations. `0025` adds durable Apple jobs and the daily
  Spotify artist ledger; `0026` adds the distinct Friday catch-up priority phase.

## Architecture State

- Verified: one short-lived recurring tick claims a due durable Apple job first, otherwise one
  bounded Spotify work unit. Execution remains behind default-off capability flags.
- Verified: full Apple scan Thursday at 9:00 PM and catch-up Friday at 9:00 AM in
  `America/Los_Angeles`, with a 24-hour bounded startup-recovery window.
- Verified: broad Spotify work is blocked Thursday and Friday. Saturday-Wednesday broad work is
  capped at 75 distinct artists and 300 request starts per local day.
- Verified recurring order: full-scan Apple priority, playlist checkpoint, Friday catch-up
  priority, playlist checkpoint, broad rotation, then historical repair. Priority work preempts
  broad work.
- Verified: an expired Spotify cooldown restores the persisted playlist or priority phase instead
  of skipping bootstrap work.
- Verified: the 1,200-request rolling ceiling reserves 200 Spotify requests for priority work and
  20 for playlist additions. Every Spotify request uses the shared PostgreSQL gate at concurrency
  one and at least ten seconds between starts.
- Verified: Apple jobs, Spotify work, daily artist claims, leases, cursors, request telemetry,
  cooldowns, and next scheduled jobs survive restart. Missed broad days do not stack.
- Verified: add-only playlist export inserts at position zero in discovery order and never
  removes, replaces, reorders, or edits user-added tracks.

## Operational State

- Bootstrap campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94` remains
  `completed_with_spotify_deferred`; its Apple discoveries and reconciliation results are
  preserved.
- Thursday bootstrap job is recorded complete. Friday catch-up is durably scheduled for Friday
  9:00 AM Pacific with bounded recovery.
- Spotify cooldown is stored until `2026-08-08T18:32:23.020Z`, August 8 at 11:32:23 AM PDT.
- No live Spotify, Apple, MusicBrainz, Reddit, or SoundCloud request was made during this audit.
- Recurring execution and Spotify scheduler execution remain disabled. Read-only status works via
  `pnpm discovery:scheduler:status`.

## Validation

- Passed: formatting, lint, strict TypeScript across 6 workspaces, and production build with 27
  routes.
- Passed: 413 unit tests across 60 files.
- Passed: 119 PostgreSQL integration tests across 24 files, including restart recovery, bounded
  missed-job handling, cooldown restoration, strict priority checkpoints, Thursday/Friday broad
  blocking, request reserves, and the 75-artist daily ceiling.
- Passed: 29 Playwright tests.
- Passed: `pnpm doctor` with overall `READY`; the active provider-directed Spotify cooldown is the
  expected action-required item. No stale locks exist.
- Passed: scheduler status command and `git diff --check`.

## Risks And Known Limits

- Spotify's quota remains unpublished. Local ceilings and reserves reduce risk but cannot
  guarantee that Spotify will not return 429.
- Automatic execution is credential-free and database-backed verified but has not completed a
  full live recurring week.
- The Friday catch-up is an incremental mapped-watchlist Apple scan, not a second historical
  backfill.
- Windows Task Scheduler must invoke the unified tick. PostgreSQL remains the schedule authority.

## Immediate Next Step

After the Spotify cooldown expires, run doctor, perform the already-approved playlist checkpoint,
then enable and observe one bounded unified scheduler tick. Do not enable broad Spotify work before
the playlist and Apple-priority phases complete.

## Deferred

- Live validation of a complete Thursday-Friday-Saturday recurring transition
- Any Spotify pacing or quota increase
- Broad historical reconciliation beyond the bounded daily rotation
- MusicBrainz production reactivation, Reddit activation, SoundCloud automation, and new providers
