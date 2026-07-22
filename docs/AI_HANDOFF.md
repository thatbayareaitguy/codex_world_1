# AI Handoff

Updated: 2026-07-22 16:45 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`, tracking the matching remote branch.
- Latest committed checkpoint after this task: current `HEAD` (`feat: implement rolling Spotify scheduler`). The preceding design checkpoint is `e224febf12376b387fc52ddf036ada9d286cf043`.
- Current milestone: rolling 24-hour Spotify scheduler implementation and credential-free validation.

## Confirmed Working

- PostgreSQL is healthy with 15 forward migrations, `0000` through `0014`.
- Migration `0014_parallel_quasar.sql` adds durable scheduler state, typed work, leases, due-time indexes, and nullable scheduler request context without rewriting prior migrations.
- The scheduler supports read-only planning and injected credential-free ticks. Production execution requires both an explicit environment capability and a non-disabled database mode; both remain disabled.
- Tick limits are one artist, six Spotify request starts, 90 seconds, concurrency one, and at least 10 seconds between production request starts. OAuth refreshes and started retries count.
- Base, release-detail, release-track, and reconciliation work share one durable queue. Existing artist coverage, provider cooldown, global request gate, operation lock, and album-track checkpoints remain authoritative.
- New release details can be deferred into typed work and resume through existing per-track-page persistence. Due base work preempts urgent detail work; reconciliation remains subordinate.
- The active watchlist remains 593 mapped artists. The scheduler bootstrap contains 593 base items and 99 reconciliation items; automatic mode is disabled and no scheduler lease is active.
- Batch 3 remains untouched with 15 pending artists and zero requests. Playlist writes remain disabled.

## Credential-Free Verification

- Read-only scheduler plan: one overdue base item selected, zero requests started, no lease claimed, no domain mutation.
- Unit tests: 273 passed in 38 files.
- PostgreSQL integration tests: 72 passed in 13 files, including clean migration, upgrade from 14 migrations, lease recovery, detail interruption, and the 593-artist simulated day.
- Strict TypeScript: passed across all six checked workspace projects.
- Format passed. Lint passed with zero warnings. Production build passed with 23 pages generated and all routes validated. Playwright passed 23 tests.
- Doctor reports `READY`: 15 migrations, no cooldown, no stale lock, 692 queued scheduler items, zero blocked items, and no active scheduler lease.
- Safe before/after counts are unchanged: 489 Spotify request events with latest timestamp `2026-07-22T07:56:50.887Z`; 101 successfully covered and 492 never-scanned artists; 93 releases; 186 tracks; 204 appearances, candidates, evidence rows, and feed rows; zero playlist requests.
- No live provider or playlist test is authorized for this milestone.

## Implemented, Not Live-Tested

- Production scheduler executor, one-tick PowerShell launcher, rolling local request ceilings, detail-work execution, cooldown recovery, and automatic mode.
- Credential-free scale simulation is engineering evidence only. It is not proof of live Spotify behavior or production-scale reliability.

## Security And Policy

- No credential, token, authorization header, raw provider payload, or personal account data is stored here.
- Valid Spotify cooldowns cannot be cleared, shortened, probed, or bypassed by the scheduler.
- No Windows scheduled task is registered or enabled. No live Spotify, playlist, MusicBrainz, Reddit, SoundCloud, or other provider request was made.
- Spotify playlist writes, Reddit, automatic SoundCloud access, and scheduler automatic execution remain disabled.

## Known Risks And Decisions

- Spotify Development Mode limits are unpublished. The 10-second pace and local rolling ceilings reduce burst risk but do not guarantee absence of future 429 responses.
- Host downtime or cooldown can make 24-hour completion impossible; estimates are ranges and become blocked when appropriate.
- The 1,200-request rolling daily ceiling is an application safeguard, not a Spotify quota.
- Batch 3 remains preserved. The user must separately approve any ten-artist live validation cohort and later automatic activation.

## Uncommitted Files

- None expected after the implementation checkpoint is created and pushed.

## Next Action

Finish credential-free verification, commit and push the implementation checkpoint, then review a separate ten-artist live validation plan. Do not start that validation or activate automatic mode in this task.
