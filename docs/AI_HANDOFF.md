# AI Handoff

Updated: 2026-08-18 21:10 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting HEAD and upstream for this correction: `a8be3006f9d582e95cb11933684f48027ac6ee71`
- Unrelated `outputs/` remains untracked and excluded. No secret or `.env` file was changed.

## Fresh Backup

- Created before code or production-state changes:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-19T03-47-56-616Z.dump`
- Size: 30,696,688 bytes
- SHA-256: `94AD0F1C5C0C9448420D5B29C41EB745F29294893B8643F6124C99AA4EDBA17C`
- `pg_restore --list` validated the PostgreSQL 17.10 custom archive with 514 table-of-contents entries.
- `last-backup.json` references this archive.

## Playlist Export Correction

- Root cause: every completed broad Spotify work item marked the playlist inbox pending. Once broad
  Artist Albums work reached its checkpoint, each minute's repair work invoked a full export even
  when the cached playlist already had every eligible track in the correct order.
- Those zero-change exports unnecessarily acquired Spotify access, read playlist metadata, and
  created a completed run plus operation rows. The stored ordering-conflict number was pairwise
  inversion history rather than the number of actual reorder moves still required.
- A database-only checkpoint inspection now runs before the Spotify request gate or client is
  created. Broad work requests an export only for a pending addition, an actual reorder move, an
  incomplete prior operation, a missing snapshot, or the legitimate 24-hour reconciliation.
- A no-work checkpoint completes the inbox without a provider request or export ledger. Cache-hit
  verification advances the reconciliation timestamp so the 24-hour check does not repeat each
  minute.
- Exact target restrictions, snapshot checks, Custom Order, Spotify Date Added and Added By
  provenance, additions-only writes, the unmanaged user-added track, and idempotency remain intact.
- Live baseline before the correction was 164 runs, 229,068 operations, and 4,863 Spotify requests.
  One legitimate pending addition then produced run 165, 230,504 operations, and 4,868 requests.
  Repeated natural scheduler ticks through 21:10 PDT left all three totals unchanged.

## Manual Review And Identity State

- Chosen Spotify candidates that are not exact and have no prior manual decision are now projected
  into the existing release review queue. Reconciliation is database-only and idempotent.
- Production currently shows one release review: `phantom parade` by Bad Computer. It offers the
  existing Keep separate and Confirm match decisions. It remains blocked from export until decided.
- A previous Keep separate decision for Sub Focus `ELEVATE` was incorrectly treated as uncertain for
  its own canonical Spotify recording. A high-confidence `manual_separate` identity is now exact for
  that recording, while still keeping the two artist identities separate. The natural scheduler then
  added the legitimately pending track in run `f62793c5-df33-4767-8c1e-f9b0afbdba85`.
- The reported 10 Apple identity decisions and 53 proposals are inactive historical records. All 10
  artists are unfollowed Spotify imports with confirmed Spotify identities and no track credits.
  Nine retain 53 historical Apple proposals; CLEMS has an old requires-manual status without a
  proposal. None is active Apple work and the review UI already excludes them.
- Historical rows were preserved. Doctor reporting now separates active unresolved work from
  inactive history: active unresolved artists 0, active pending proposals 0, inactive unresolved
  artists 10, inactive pending proposals 53, and issues 0.

## Reporting Corrections

- The exports dashboard now calculates Ready, Exported, and Blocked from the complete database
  playlist plan instead of the currently loaded feed page.
- The production dashboard now reports Ready 0, Exported 1,105, and Blocked 122.
- Spotify `queue_depth` is reconciled only when an abandoned counter is stale, no live lease exists,
  and the request interval has elapsed. The stale production value changed from 1 to 0 naturally.
- Ordering status now reports actual pending range-reorder moves. Production currently has 0 pending
  reorder moves, not the previous 319 pairwise inversions.

## Thursday And Friday Workflows

- Thursday, August 13 at 21:00 PDT: the full Apple workflow completed at 21:23. It processed 583 of
  583 artists with zero failures and 1,270 requests. It discovered 240 candidates, inserted 132,
  skipped 108, and sent 14 to review.
- Apple-priority Spotify work started automatically afterward. It used the configured 80 of 80
  Artist Albums allowance and 21 release-detail requests without a 429 or provider cooldown.
  Automatic exports ran only after eligible priority work reached its checkpoint.
- Friday, August 14 at 09:00 PDT: catch-up completed at 09:22. It processed 583 of 583 artists with
  zero failures and 1,214 requests. It discovered 127 candidates, inserted 0, skipped 127 existing
  records, and created 0 reviews.
- The catch-up and its downstream priority/export routing completed under persisted scheduler state.
  No manual provider scan or duplicate campaign was launched during this correction.

## Current Production State

- PostgreSQL is healthy on `127.0.0.1:5432`; all 30 migrations are applied. The Docker `db` service
  has `restart: unless-stopped` and was up and healthy for more than 27 hours at final verification.
- Authorized Spotify playlist: `4l6LaMPL6duulmFe3hRR4Y`.
- Cached state: 1,164 tracks, 1,163 scanner-managed, 1 unmanaged user-added track, 0 duplicate track
  IDs, 0 pending additions, 0 incomplete operations, and 0 pending reorder moves. The user-added
  track remains preserved.
- Current full plan: 1,105 exported eligible recordings, 122 blocked canonical recordings, and 207
  duplicate feed appearances intentionally skipped.
- Spotify has no active lease or cooldown and no 429 in the last 24 hours. All-time telemetry retains
  five quota-classified and two legacy 429 events, with the latest on August 9. Artist Albums remains
  78 of 80 for the current trailing window, with the configured priority reserve intact.
- The broad scheduler backlog is 1,217 queued and 10 blocked work items. This is scheduled catalog
  work, not a stuck lease. Playlist inbox status is completed with zero pending additions.

## Windows And Web Recovery

- `TS New Music Radar Recurring Discovery` remains enabled, hidden, direct, and non-overlapping. It
  runs every minute with `conhost.exe --headless node.exe --env-file=... --import tsx ... tick`.
  Its 21:09 PDT execution returned 0 and the next minute was scheduled normally.
- `TS New Music Radar Web Application` remains enabled, hidden, non-overlapping, and running from its
  current-user logon trigger. Its direct action remains:
  `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\web-supervisor-cli.ts"`
- Live reboot recovery was previously validated on August 17. After Windows boot, the supervisor
  retried while Docker was unavailable, reached PostgreSQL on attempt 7, applied migrations, and
  restored loopback web health. During this correction, a controlled stop of verified Next child PID
  31080 was restored as PID 4840 in about 10 seconds. `/api/health` returned `ok`, and no visible
  console appeared.

## Validation

- `pnpm format:check`: passed
- `pnpm lint`: passed with zero warnings
- `pnpm typecheck`: passed across all six workspace projects
- `pnpm test`: 67 files and 489 tests passed
- `pnpm test:integration`: 27 files and 148 tests passed with all 30 migrations
- `pnpm build`: production Next.js build passed with 27 pages and routes
- `pnpm test:e2e`: 31 Playwright tests passed
- `pnpm run doctor`: READY
- In-app browser smoke: exports showed 0 ready, 1,105 exported, and 122 blocked; release review showed
  one actionable uncertain Spotify match; Apple mapping review showed zero active unresolved artists;
  browser console errors and warnings were empty.

## Remaining Non-Blocking Work

- The 1,217 broad Spotify jobs and 10 blocked jobs continue under the existing daily and trailing
  budgets.
- The 122 blocked playlist candidates require future provider evidence or human decisions where an
  uncertain candidate exists. They are not eligible for automatic export.
- The intentional 24-hour playlist reconciliation may perform minimal Spotify metadata reads and
  record a reconciliation run even when it confirms no changes. Per-minute no-work churn is fixed.
