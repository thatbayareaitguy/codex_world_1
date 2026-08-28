# AI Handoff

Updated: 2026-08-27 17:26 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- HEAD and upstream before the review-link correction: `46217ef2c0bb956910760bbfacbb81fac064afe2`
- `outputs/` is unrelated, remains untracked, and is excluded from the intended commit.
- No secret or `.env` file was changed.

## Fresh Backup And Database

- Created before code or production-state changes:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-27T23-15-22-057Z.dump`
- Size: 35,104,523 bytes
- SHA-256: `1CE638086296D2D2920805B9D130F1646F2E891223F8DD182F4BF549EB208F76`
- `pg_restore --list` verified the PostgreSQL 17 custom-format, gzip-compressed archive with 514
  table-of-contents entries.
- Production PostgreSQL is healthy on `127.0.0.1:5432`. Migration
  `0030_mature_silver_surfer.sql` is applied and all 31 migrations are current.
- Docker service `db` still uses `restart: unless-stopped`.

## August 23-24 Missed-Window Audit

- The old `TS New Music Radar Recurring Discovery` registration used an `InteractiveToken`
  principal, ran every minute, and had `WakeToRun`, `StartWhenAvailable`, `IgnoreNew`, and hidden mode
  enabled. Its direct action already used `conhost.exe --headless node.exe --import tsx`.
- Windows supports S3 sleep and hibernation. The active High Performance plan permits wake timers on
  AC and DC power. `powercfg /lastwake` proves the old recurring task successfully woke the PC during
  an ordinary signed-in sleep on August 25.
- The System log shows the PC slept from August 22 at 06:50 PDT until August 25 at 10:36 PDT, when the
  power button woke it. A Windows Update reboot occurred shortly before that long sleep. No scanner
  task wake occurred during the August 23-24 maintenance windows.
- The evidence distinguishes this from a provider, quota, PostgreSQL, or web crash. The old task had
  no dedicated maintenance boundary and depended on a usable interactive user session. The missed
  windows followed a reboot and long lock-screen sleep, so the available evidence points to the
  unsupported signed-out or not-yet-interactive state rather than ordinary signed-in sleep.
- Task Scheduler's Operational log was disabled, so Windows retained no per-attempt task history for
  those missed triggers. Shutdown and signed-out reboot operation remain intentionally unsupported.

## Windows Scheduler After Correction

Registration is through:

```powershell
pnpm discovery:scheduler:register
```

Two tasks are now registered for the current signed-in user:

1. `TS New Music Radar Recurring Discovery`
   - Hidden, enabled, `IgnoreNew`, `StartWhenAvailable`, restart 3 times at one-minute intervals, and
     a three-minute execution limit.
   - Repeats once per minute while Windows is awake.
   - `WakeToRun` is disabled, so this poller no longer creates a wake request every minute.
   - Direct action:
     `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --env-file="C:\Users\taysh\AppData\Local\TSNewMusicRadar\production-scheduler.env" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\discovery-scheduler-cli.ts" tick`
   - Natural post-registration executions returned 0 with zero missed runs. After the idempotent
     re-registration check, the latest inspected run was 17:23 PDT and returned 0.

2. `TS New Music Radar Maintenance Window`
   - Hidden, enabled, `IgnoreNew`, `StartWhenAvailable`, `WakeToRun`, restart 3 times at one-minute
     intervals, and a four-hour execution limit.
   - Direct action:
     `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --env-file="C:\Users\taysh\AppData\Local\TSNewMusicRadar\production-scheduler.env" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\discovery-maintenance-cli.ts"`
   - Fixed Pacific triggers:
     - Saturday through Wednesday at 08:50 and 20:50
     - Thursday at 20:50
     - Friday at 08:50
   - Next fixed trigger at final inspection: Thursday, August 27 at 20:50 PDT.
   - `267011` is the Windows never-run status for this newly created task, not a failed execution.

The maintenance process reads the existing PostgreSQL schedule, queues, request budgets, cooldown,
and playlist checkpoint. It calls the existing scheduler tick and contains no second scanner. It
holds a hidden Windows `ES_SYSTEM_REQUIRED` request only during runnable work or a known wait of 15
minutes or less, releases it in `finally`, exits immediately when no eligible work exists, and stops
after four hours.

Idempotent re-registration was live-verified at 17:23 PDT. After re-registration, the minute task
still had exactly one `MinuteScheduler` trigger, `WakeToRun=false`, `IgnoreNew`, a three-minute
limit, and last result 0 with zero missed runs. The maintenance task still had exactly the four
fixed triggers, no duplicate `DynamicCapacityWake`, `WakeToRun=true`, `IgnoreNew`, a four-hour
limit, and the next run at 20:50 PDT.

Isolated tests now also verify that the keep-awake helper requests
`ES_CONTINUOUS | ES_SYSTEM_REQUIRED`, runs hidden, and releases its child process; that non-Windows
operation is a no-op; and that dynamic wake updates preserve fixed triggers, tolerate an unchanged
time, keep at most one `DynamicCapacityWake`, and remove it cleanly.

If priority or playlist work is blocked only by cooldown or rolling Artist Albums capacity, the
ordinary tick updates one trigger named `DynamicCapacityWake`. The trigger is ten minutes before the
database-calculated next runnable time. Re-registration preserves it, updates are idempotent, and a
long wait releases the keep-awake request. There was no dynamic trigger at final inspection because
no priority or playlist work was waiting on capacity.

Configuration verification is complete, but a live wake by the new maintenance task is not yet
proven. `powercfg /waketimers` requires an administrator-elevated command prompt on this machine, and
the maintenance task's first natural trigger is 20:50 PDT. A manual task invocation was not used
because 575 broad artists are due and the safety reviewer correctly rejected any claim that such a
run was guaranteed mutation-free. Do not force sleep. Use a user-assisted signed-in sleep test at a
fixed maintenance trigger, then confirm the Power-Troubleshooter event names the maintenance task.

The same safety restriction was re-confirmed at 17:24 PDT after current status showed 577 due broad
artists. Although Thursday gating should return `no_work` before 20:50, the manual maintenance task
was not invoked after the safety reviewer rejected it. No workaround was attempted. The first
natural maintenance trigger remains the authoritative live test.

## Review Workflow

- Migration 0030 adds `manual_match_decisions.deferred_until` for durable seven-day deferrals.
- The Needs Review page now shows only persisted release-candidate decisions plus existing artist
  identity decisions. Release cards identify the actual Apple Music or Spotify source and show
  artwork, artist, title, release type, date, track, provider links, evidence, confidence, and the
  blocking explanation.
- Durable release actions are:
  - Confirm candidate
  - Select a specific candidate card when alternates are shown
  - Confirm a supplied Spotify track link through guarded manual-resolution work
  - Mark no Spotify equivalent for a non-Spotify candidate
  - Retry matching through guarded ISRC resolution
  - Keep separate
  - Defer for seven days
- Retry and selected-track confirmation require a canonical ISRC, primary credit, and confirmed
  Spotify artist mapping. They enqueue the existing resolution worker and never call Spotify from a
  browser request. Resolved tracks reach the existing fixed-target exporter through normal scheduler
  eligibility checks. No direct or duplicate export path was added.
- System-waiting tracks are shown separately with status, due time, attempt count, source, and exact
  queue or retry reason. They expose no misleading manual action.
- Every visible release-review card now places a specifically named `Open Spotify track for ...`
  link above the provider comparison. It uses the card's stored Spotify evidence or Spotify
  candidate first. An Apple card can reuse a sibling Spotify candidate only when there is exactly
  one unique stored Spotify URL with the same normalized artist, title, release date, and release
  type. Zero or multiple candidates remain explicitly unresolved rather than linking to a guessed
  track.
- Provider candidate links now identify their destination, such as `Open Apple Music candidate`,
  and the provider-label comparison accepts the display labels returned by the feed API.
- Live browser verification after the controlled restart found 21 review cards, 21 exact Spotify
  track links, and zero missing-link notices. The previously unlinked Apple Music `NASTY` card now
  exposes the same stored Spotify candidate URL as its uniquely matching Spotify review card.

Current production classification:

- 21 visible manual candidate records: 13 Spotify and 8 Apple Music
- 23 total candidate rows remain `needs_review`; two have no visible `needs_review` feed row
- 105 blocked export tracks
- 2 blocked tracks have a visible user-actionable candidate
- 102 are waiting on guarded Spotify work, and all 102 detail rows are returned
- 0 are terminal or marked no Spotify equivalent
- 0 are currently deferred
- 1 has stale or invalid state and no matching actionable or waiting record

The goal was written when 22 manual records had been reported. The authoritative post-backup baseline
was already 21. The latest prior manual decision was recorded at 16:11 PDT, four minutes before this
backup, and this work did not make any live review decision.

## Current Operational State

- Doctor reports READY. There are no failed scans awaiting attention, stale scan locks, active
  Spotify lease, or active Spotify cooldown.
- Spotify telemetry has 0 429s in the last 24 hours and retains five quota-classified plus two legacy
  historical 429s. The latest quota event was August 9.
- Current scheduler status reports 1,192 queued and 10 blocked work rows. Artist Albums usage is
  12 of 80 with the 20-request priority reserve intact. The playlist inbox is completed with zero
  pending operations.
- The latest successful provider work remains August 26 at 17:38 PDT. No provider scan or playlist
  write was manually triggered during this correction.
- The authorized Spotify playlist target and all existing snapshot, additions-only, Custom Order,
  Date Added, Added By, user-added-track, ownership, collaboration, cooldown, quota, and idempotency
  safeguards are unchanged.
- The hidden web supervisor is running the validated production build on `127.0.0.1:3000`. A
  controlled stop for this correction replaced Next child PID 51568 with PID 54388 under supervisor
  PID 55768 in under nine seconds. `/api/health` returned `ok`, and the command line remains
  loopback-only.
- This review-link correction made no provider request, review decision, scheduler invocation,
  playlist write, database mutation, or credential change.

## Validation

- `pnpm format:check`: passed
- `pnpm lint`: passed with zero warnings
- `pnpm typecheck`: passed across all six workspace projects
- `pnpm test`: 71 files and 504 tests passed, including four isolated Windows maintenance
  lifecycle tests
- `pnpm test:integration`: 27 files and 152 tests passed against the isolated `db-test` PostgreSQL
  service with all 31 migrations. Production port 5432 was not touched.
- `pnpm build`: passed, including 28 generated pages and routes
- `pnpm test:e2e`: 32 Playwright tests passed, including exact Spotify-link coverage for paired
  Apple Music and Spotify review cards
- `pnpm doctor`: READY
- `git diff --check`: passed
- In-app browser smoke: the live page reports 21 manual records and the 2/102/0/1 blocked
  classification, identifies Spotify and Apple candidates correctly, exposes all durable actions,
  and shows one exact Spotify track link on each of the 21 review cards.

## Remaining Verification

- Run `powercfg /waketimers` from an administrator-elevated prompt to confirm Windows has armed the
  maintenance task's next fixed trigger.
- Complete one user-assisted signed-in sleep test. Do not shut down or sign out. After wake, inspect
  `powercfg /lastwake` and the System Power-Troubleshooter event.
- Observe the first natural maintenance execution and record its result. The code-level early-exit,
  no-overlap, idempotent dynamic-trigger, bounded-runtime, and keep-awake-release paths are covered by
  tests, but the new task has not yet executed in production.
