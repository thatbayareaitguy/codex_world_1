# AI Handoff

Updated: 2026-08-08 03:03 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Current implementation checkpoint: `3aa32b7` (`fix: automate scheduled Spotify playlist delivery`)
- Current milestone: automatic guarded Thursday/Friday Spotify playlist delivery is implemented and
  credential-free verified
- Upstream: matches `origin/codex/release-radar-hardening` after the handoff sync commit
- Worktree: clean except unrelated untracked `outputs/`, which remains excluded
- PostgreSQL: healthy with 28 forward migrations after applying `0027`, which adds Spotify request
  quota lanes and an endpoint-window index.

## Architecture State

- Verified: one short-lived recurring tick claims a due durable Apple job first, otherwise one
  bounded Spotify work unit. Execution remains behind default-off capability flags.
- Verified: full Apple scan Thursday at 9:00 PM and catch-up Friday at 9:00 AM in
  `America/Los_Angeles`, with a 24-hour bounded startup-recovery window.
- Verified: broad Spotify work is blocked Thursday and Friday. Saturday-Wednesday broad work is
  capped at 75 distinct artists and 300 request starts per local day.
- Verified recurring order: drain a previously pending export, Apple scan, Apple-priority Spotify
  resolution, guarded automatic export, then Saturday-Wednesday broad rotation. The final priority
  resolution reconciles the durable phase and invokes the existing exporter in the same tick.
  Friday catch-up uses the same sequence, and priority work preempts broad work.
- Verified: an expired Spotify cooldown restores the persisted playlist or priority phase instead
  of skipping bootstrap work.
- Implemented: the 1,200-request rolling ceiling retains 200 requests for priority work and 20 for
  playlist operations. Artist Albums has a separate 80-call trailing 24-hour allowance with 20
  reserved for priority. Unused reserve releases after 20 hours only when priority is empty.
- Implemented: endpoint telemetry distinguishes Artist Albums, album details, album tracks,
  playlist reads, playlist writes, and OAuth or other requests. Playlist work is not blocked by an
  exhausted Artist Albums bucket.
- Verified: simplified Artist Albums summaries persist before any album-detail request. A detail
  failure or restart therefore retains the release observation and later work remains resumable.
- Verified by unit and focused PostgreSQL tests: every Spotify request uses the shared gate at
  concurrency one and at least ten seconds between starts; an unchanged known release makes one
  Artist Albums request and no album-detail or track request.
- Verified: Apple jobs, Spotify work, daily artist claims, leases, cursors, request telemetry,
  cooldowns, and next scheduled jobs survive restart. Missed broad days do not stack.
- Verified: add-only playlist export inserts at position zero in discovery order and never
  removes, replaces, reorders, or edits user-added tracks.
- Verified: New projects only feed rows matching the New state. Released preview tracks from an
  unreleased album remain visible individually, while the future album group and upcoming sibling
  tracks remain in All and Upcoming.
- Implemented and credential-free verified, but not live-tested as a recurring week: the unified
  tick invokes the existing single-playlist add-only exporter automatically for Thursday and Friday.
  Restarted ticks resume a pending export before broad work. A Spotify 429 persists cooldown state
  and keeps the export phase pending until provider readiness returns.
- Automatic writes require all ignored local production settings:
  `DISCOVERY_SCHEDULER_ENABLED=true`, `SPOTIFY_SCHEDULER_ENABLED=true`,
  `SPOTIFY_PLAYLIST_WRITES_ENABLED=true`, and
  `SPOTIFY_ALLOWED_PLAYLIST_ID=4l6LaMPL6duulmFe3hRR4Y`. Defaults and tests remain write-disabled.
- The UI distinguishes awaiting Spotify resolution, awaiting playlist export, exporting, cooldown
  pause, retry, and export-complete states.

## Operational State

- Bootstrap campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94` remains
  `completed_with_spotify_deferred`; its Apple discoveries and reconciliation results are
  preserved.
- Thursday bootstrap job is recorded complete. Friday catch-up is durably scheduled for Friday
  9:00 AM Pacific with bounded recovery.
- Spotify cooldown is stored until `2026-08-08T18:32:23.020Z`, August 8 at 11:32:23 AM PDT.
- No live Spotify, Apple, MusicBrainz, Reddit, or SoundCloud request was made during this milestone.
- Recurring execution and Spotify scheduler execution remain disabled. Read-only status works via
  `pnpm discovery:scheduler:status`.

## Validation

- Passed: formatting, lint, strict TypeScript across 6 workspaces, and the 27-route production build.
- Passed: 436 unit tests across 60 files, 133 PostgreSQL integration tests across 25 files, and 30
  Playwright tests.
- Passed: migration application, live local UI smoke inspection of the persisted cooldown state,
  browser console error check, and `git diff --check`.
- Doctor: PostgreSQL is healthy with 28 migrations, no stale locks, valid playlist boundaries, and
  both required Spotify playlist scopes. It correctly reports the provider-directed Spotify
  cooldown as an action item until `2026-08-08T18:32:23.020Z`. Artist Albums has 101 trailing
  24-hour calls against the local 80-call ceiling, so no Artist Albums work is eligible before
  capacity returns; playlist request accounting remains separate at 0 reads and 0 writes.

## Risks And Known Limits

- Spotify's quota remains unpublished. Local ceilings and reserves reduce risk but cannot
  guarantee that Spotify will not return 429.
- Automatic execution is credential-free and database-backed verified but has not completed a
  full live recurring week.
- Spotify's endpoint limits are unpublished. The 80-call Artist Albums allowance is deliberately
  conservative and requires operational review after sustained use.
- Automatic playlist delivery is code-, PostgreSQL-, and browser-test verified only; it has not
  completed a live Thursday-Friday transition.
- The Friday catch-up is an incremental mapped-watchlist Apple scan, not a second historical
  backfill.
- Windows Task Scheduler must invoke the unified tick. PostgreSQL remains the schedule authority.

## Immediate Next Step

After the provider cooldown has expired, run doctor and validate one bounded Thursday or Friday
transition under explicit live approval. Do not enable broad Spotify work before playlist and
Apple-priority phases complete.

## Deferred

- Live validation of a complete Thursday-Friday-Saturday recurring transition
- Any Spotify pacing or quota increase
- Broad historical reconciliation beyond the bounded daily rotation
- MusicBrainz production reactivation, Reddit activation, SoundCloud automation, and new providers
