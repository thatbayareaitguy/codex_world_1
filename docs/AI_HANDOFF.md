# AI Handoff

Updated: 2026-08-16 20:17 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting HEAD and upstream for this change: `5c03fe7901c3a455b75184b375b3ff7eb1b62e26`
- Unrelated `outputs/` remains untracked and excluded. No secret or `.env` file was changed.

## Missing Spotify Mapping Root Cause

- Spotify Artist Albums was requested as one combined `album,single,appears_on,compilation`
  page with a maximum of 10 results. Spotify does not document that response as newest-first.
- The scanner treated page zero as the recent catalog. For Ganja White Night, that page contained
  older albums, so the new `Wonky` release was never detailed. The playlist exporter correctly
  skipped the Apple discovery because its canonical track had no persisted Spotify track ID.
- Refreshing priority artist offset zero fixed one path but could not guarantee that a recent single
  appeared in the combined first page. The durable per-track correction below closes that gap.

## Implemented Resolution

- Migration `0029_violet_ink.sql` adds durable `track_resolution` scheduler work with ISRC, target
  canonical track, expected confirmed Spotify artist, optional exact Spotify track ID, and mode.
- Apple discoveries with a provider-neutral ISRC and no Spotify evidence are automatically queued.
  The scheduler first searches Spotify by exact ISRC. It requires the returned track to include the
  confirmed Spotify artist. ISRC is the exact recording match, so harmless title formatting
  differences do not reject it.
- An ISRC miss queues separate page-zero `single` and `album` requests, then sends relevant release
  details through the existing deterministic matcher. This avoids relying on combined Artist Albums
  ordering. Automatic ISRC misses retry after 24 hours until Spotify evidence exists.
- Apple-priority discoveries enter this queue immediately after their Apple batch. Existing Apple
  discoveries are backfilled idempotently during scheduler reconciliation.
- Apple-only feed cards now accept an exact `open.spotify.com/track/...` URL. The request only queues
  work. The recurring scheduler later reads that public track through the shared Spotify gate and
  verifies exact ISRC plus confirmed artist identity before persisting it.
- User-supplied exact links run ahead of broad Spotify scanning and do not consume broad daily scan
  capacity. They still respect the global 30-minute and 24-hour request limits, the 10-second request
  interval, concurrency one, and any provider cooldown.
- Invalid manual links become a visible mismatch instead of retrying forever. Queued, verifying, and
  mismatch states are projected from PostgreSQL. Every feed appearance of a matched canonical track
  now shows its safe Spotify track link, including the original Apple appearance.
- Spotify data remains Spotify-namespaced. Apple ISRC evidence is used only to locate Spotify
  evidence, and no Spotify response is sent to Apple Music or another provider.

## Wonky Verified Outcome

- Canonical track: `a0acf493-e364-42fc-ad10-e3ea9754d28d`
- ISRC: `CA5KR2665824`
- Supplied Spotify track: `0M6v8qTwT7wfiEsAmLQKdd`
- The exact-link work waited while 35 requests occupied the configured 30-request rolling window.
  No limit or cooldown was bypassed.
- The unchanged recurring task verified and persisted the Spotify ID at 20:10 PDT. Both the manual
  work and its redundant automatic ISRC work are completed.
- The automatic playlist workflow added Wonky at 20:11 PDT. A later export recognized the other feed
  appearance as the same recording and skipped that duplicate without removing or re-adding it.
- Final browser verification shows Spotify on both the Spotify and original Apple feed appearances,
  and both report `Exported`.

## Startup And Recovery Verification

- Windows task `TS New Music Radar Web Application` remains enabled, hidden, StartWhenAvailable,
  non-overlapping with `IgnoreNew`, and configured for three one-minute failure restarts.
- Trigger: current-user logon.
- Exact action:
  `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\web-supervisor-cli.ts"`
- The supervisor waits up to 60 ten-second attempts for Docker and PostgreSQL, applies migrations,
  removes stale PID records safely, avoids a duplicate when health already responds, binds Next.js
  only to `127.0.0.1:3000`, and restarts an unexpectedly exited child.
- Final controlled recovery stopped verified web PID `57020`; supervisor PID `50040` restored web PID
  `40520`, and `/api/health` returned `ok`. The web and supervisor processes reported
  `MainWindowHandle=0`. No visible console appeared and no Windows restart was performed.

## Validation

- `pnpm format:check`: passed
- `pnpm lint`: passed with zero warnings
- `pnpm typecheck`: passed across all six workspace projects
- `pnpm test`: 67 files and 488 tests passed
- `pnpm test:integration`: 27 files and 145 tests passed after provisioning `db-test` and applying
  all migrations
- `pnpm build`: production Next.js build passed with 27 routes
- `pnpm test:e2e`: 31 Playwright tests passed
- `pnpm doctor`: READY
- `git diff --check`: passed
- In-app browser smoke test: Wonky's original Apple appearance showed both Apple Music and Spotify,
  the Spotify appearance showed Spotify, and both showed `Exported`.

## Current Operational State

- PostgreSQL is healthy on `127.0.0.1:5432`; 30 migrations are applied.
- Spotify has no active cooldown and no 429 in the last 24 hours. Artist Albums usage remains 80/80.
- Track resolution has completed five automatic ISRC jobs and one manual job. The backlog contains
  127 ISRC jobs and one `single` fallback. These continue only as safe request capacity returns.
- The last completed playlist run had 1 addition, 1,095 already present, 332 skipped, and 0 failures.
  A newer automatic run was active with 1 planned addition, 1,096 already present, 332 skipped, and
  0 failures at the evidence snapshot.
- Thursday Apple discovery remains the latest Apple scan. It completed all 583 artists with zero
  failures. The next full Apple run is Thursday, August 20 at 21:00 PDT, followed by the configured
  Friday catch-up.
- Apple has no active request lease or cooldown. No Apple request was made during this work.
- `TS New Music Radar Recurring Discovery` remains enabled, hidden, and unchanged. Its action is
  still direct `conhost.exe --headless node.exe --env-file=... --import tsx ... tick`. It was running
  normal automatic work at the final snapshot; prior completed invocations returned result `0`.
- No provider request was invoked manually. Wonky verification and playlist addition were performed
  by the existing recurring task after its persisted limits allowed them.

## Deferred

- Automatic processing of the remaining 127 ISRC resolution jobs and one catalog fallback
- Database backup refresh after the last recorded 2026-08-04 backup
- Physical Windows restart or logoff validation
