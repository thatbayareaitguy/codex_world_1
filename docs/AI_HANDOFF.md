# AI Handoff

Updated: 2026-08-22 00:22 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting HEAD and upstream for this correction: `113d2a51db6030f8fe663e2667d752540b1dced3`
- Unrelated `outputs/` remains untracked and excluded. No secret or `.env` file was changed.

## Fresh Backup

- Created before code or production-state changes:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-22T06-28-47-302Z.dump`
- Size: 33,770,922 bytes
- SHA-256: `D66B89945F2F321F2B908BD4D6317EC3690E514CC169C78BFCE3AEF38F901AB7`
- `pg_restore --list` validated the PostgreSQL custom archive with 525 table-of-contents entries.
- `last-backup.json` references this archive.

## Friday Playlist Sync Correction

- The Friday playlist sync was blocked even after Spotify capacity returned. Six successfully
  resolved ISRC repair rows had been scheduled for their normal 24-hour recheck but still retained
  the `apple_priority` source. The priority phase counted those future rows as unfinished priority
  work, so it never reached its playlist checkpoint. This was scheduler state, not a Spotify quota,
  authentication, playlist, or provider failure.
- A completed priority ISRC resolution now moves to the normal `repair` lane when it is scheduled for
  its next-day recheck. Every scheduler tick also repairs legacy future-due rows left in a priority
  lane. The first production tick moved all six affected rows without making a provider request.
- Priority processing now performs a database-only playlist checkpoint before starting more catalog
  requests. If additions or a legitimate reconciliation are pending, confirmed songs sync first. If
  no work exists, no Spotify client, request, export run, or operation ledger is created.
- This makes the Friday behavior explicit: when rolling Spotify capacity returns, already confirmed
  playlist additions are attempted before new priority catalog work consumes that capacity. The
  existing fixed playlist target, additions-only policy, Custom Order, snapshot checks, Date Added
  and Added By preservation, user-added track handling, and idempotent resume behavior are unchanged.
- Spotify and dormant MusicBrainz request gates now recheck an active 30-second safety lease every
  250 ms. They still serialize requests and preserve the configured request-start interval, but a
  completed request no longer makes another caller sleep until the abandoned-lease deadline.
- The naturally scheduled 23:39 PDT tick opened export run
  `681c5339-60ec-420b-b482-eeee2abb2bff` for 82 additions. All additions succeeded. Spotify then
  accepted 33 snapshot-aware range moves to restore Custom Order. The run completed at 00:21 PDT
  with zero failures, ordering conflicts, 429s, or cooldowns and without creating a duplicate run.

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
- The post-recovery production dashboard reports Ready 0, Exported 1,187, and Blocked 119.
- Spotify `queue_depth` is reconciled only when an abandoned counter is stale, no live lease exists,
  and the request interval has elapsed. The stale production value changed from 1 to 0 naturally.
- Ordering status now reports actual pending range-reorder moves. Production currently has 0 pending
  reorder moves, not the previous 319 pairwise inversions.

## Thursday And Friday Workflows

- Thursday, August 20 at 21:00 PDT: the full Apple workflow completed at 21:24. It processed 583 of
  583 artists with zero failures and 1,278 requests. It discovered 237 candidates, inserted 102,
  skipped 135, and sent 10 to review.
- Apple-priority Spotify work started automatically afterward. It used the configured 80 of 80
  Artist Albums allowance without a 429 or provider cooldown. Confirmed playlist additions remained
  pending when the phase-drain defect described above prevented its checkpoint.
- Friday, August 21 at 09:00 PDT: catch-up completed at 09:22. It processed 583 of 583 artists with
  zero failures and 1,210 requests. It discovered 103 candidates, inserted 1, skipped 102 existing
  records, and created 0 reviews.
- The Apple scans themselves and their persisted progress completed as designed. The downstream
  Friday playlist checkpoint did not, until the corrected natural scheduler tick at 23:39 PDT. No
  manual provider scan or duplicate campaign was launched during this correction.

## Current Production State

- PostgreSQL is healthy on `127.0.0.1:5432`; all 30 migrations are applied. The Docker `db` service
  has `restart: unless-stopped` and was up and healthy for more than two days at final verification.
- Authorized Spotify playlist: `4l6LaMPL6duulmFe3hRR4Y`.
- Verified cached state after recovery: 1,246 tracks, 1,245 scanner-managed, 1 unmanaged user-added
  track, 0 duplicate track IDs, 0 pending additions, and 0 incomplete export operations. The
  user-added track remains preserved.
- Spotify has no active lease or cooldown and no 429 in the last 24 hours. All-time telemetry retains
  five quota-classified and two legacy 429 events, with the latest on August 9. Artist Albums remains
  40 of 80 for the current trailing window after capacity returned naturally.
- Scheduler state returned to `apple_priority` with the playlist inbox completed. It has 51 immediate
  Apple-priority and catch-up items plus 1,229 queued recurring and repair items, for 1,280 total,
  and 10 historical blocked initial items. The six future ISRC rechecks are now in `repair`; zero
  future-due ISRC rows remain mislabeled as priority work.

## Windows And Web Recovery

- `TS New Music Radar Recurring Discovery` remains enabled, hidden, direct, and non-overlapping. It
  runs every minute with `conhost.exe --headless node.exe --env-file=... --import tsx ... tick`.
  The 00:25 PDT execution after playlist recovery returned 0, no runs were missed, and the next
  minute was scheduled normally.
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
- `pnpm test`: 67 files and 491 tests passed
- `pnpm test:integration -- --maxWorkers=1`: 27 files and 151 tests passed with all 30 migrations
- `pnpm build`: production Next.js build passed with 27 pages and routes
- `pnpm test:e2e`: 31 Playwright tests passed
- `pnpm run doctor`: READY
- Post-recovery dashboard summary: 0 ready, 1,187 exported, 119 blocked, and 0 pending reorder moves.
  The prior in-app browser smoke showed the actionable uncertain-match review and zero active Apple
  mapping decisions, with no browser console errors or warnings.

## Remaining Non-Blocking Work

- The 1,229 recurring and repair Spotify jobs, 51 immediate priority jobs, and 10 blocked historical
  jobs continue under the existing daily and trailing budgets.
- The 119 blocked playlist candidates require future provider evidence or human decisions where an
  uncertain candidate exists. They are not eligible for automatic export.
- The intentional 24-hour playlist reconciliation may perform minimal Spotify metadata reads and
  record a reconciliation run even when it confirms no changes. Per-minute no-work churn is fixed.
