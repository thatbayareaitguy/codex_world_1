# AI Handoff

Updated: 2026-08-28 16:42 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Base HEAD and upstream before the system-status repair:
  `b48830b387f731f1a67bb3fa612eb4e48c0957c2`
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

Two production tasks are registered for the current signed-in user:

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

## One-Time Wake Validation

A separate temporary task named
`TS New Music Radar Maintenance Wake Validation 2026-08-28` is registered for Friday, August 28 at
02:50 PDT. It is hidden, enabled, `WakeToRun`, `StartWhenAvailable`, `IgnoreNew`, limited to five
minutes, and runs only for the current interactive user. Its one trigger is
`WakeValidation20260828` with start boundary `2026-08-28T02:50:00-07:00`.

Its direct action is:

`C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\wake-validation-cli.ts"`

The validation CLI does not import database, provider, scheduler, or playlist modules. It takes a
Windows `ES_SYSTEM_REQUIRED` request, records independent activation evidence, holds it for 90
seconds, releases it, verifies that the helper and power request have ended, and writes the result
atomically to
`C:\Users\taysh\AppData\Local\TSNewMusicRadar\logs\wake-validation-20260828.json`.
It cannot start Apple Music or Spotify work, mutate the database, or write a playlist.

A one-run Codex thread follow-up named `Verify 2:50 AM scanner wake test` is active for 02:56 PDT on
August 28. Its ID is `verify-2-50-am-scanner-wake-test`. The follow-up is explicitly read-only and
checks the task result, missed-run and overlap state, the evidence JSON, Windows wake evidence,
minute-scheduler resumption, keep-awake release, leases and errors, and the unchanged production
triggers. It does not start or stop any task and does not remove the temporary validation task.

At the 17:42 PDT pre-test inspection, the validation task was Ready with next run 02:50, zero missed
runs, and Windows never-run result `267011`. The production maintenance task still had only
`BroadMorningWake`, `BroadEveningWake`, `ThursdayAppleWake`, and `FridayCatchupWake`; its next normal
run remained 20:50 PDT. The minute scheduler remained Ready with `WakeToRun=false`, last result 0,
and zero missed runs. `powercfg /waketimers` still required administrator elevation, so the task's
`WakeToRun=true` setting is configured evidence, not yet live wake proof.

The active High Performance plan is configured to sleep after 7,200 seconds on AC power and never
automatically sleep on battery. The 90-second helper can therefore release promptly while the PC
remains awake for the 02:56 follow-up under the current power-plan settings.

For the live test, remain signed in and put the PC into ordinary sleep before 02:50. Do not shut
down, sign out, or hibernate. Those states are outside this signed-in sleep validation.

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
because 577 broad artists are due and the safety reviewer correctly rejected any claim that such a
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
- Current scheduler status reports 1,339 queued and 11 blocked work rows. Artist Albums usage is
  0 of 80 with the 20-request priority reserve intact. The playlist inbox is completed with zero
  pending operations.
- The latest successful provider work is August 28 at 13:56 PDT. No provider scan or playlist
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

## Mirrored Release Review Repair (2026-08-28)

- Apple Music and Spotify candidate rows that point to the same exact canonical release ID and
  proposed canonical track ID now share one review group. Provider evidence rows remain separate
  and are not merged or deleted.
- The review page renders one card per exact canonical group, combines the stored Apple Music and
  Spotify links, and counts the group as one human decision. Similar titles without the same two
  canonical IDs remain separate.
- Confirm, defer, retry, selected-Spotify-track confirmation, and no-equivalent decisions use the
  grouped API scope. The database applies every member decision in one transaction, so a failure
  rolls back the whole group. A group containing Spotify evidence cannot be marked as having no
  Spotify equivalent.
- Keep separate remains candidate-specific for grouped cards. The UI names the provider on each
  separate action, preventing an ambiguous group-wide split.
- Full verification passed: formatting, lint, type checking, 521 unit tests in 74 files, 154
  integration tests in 28 files against a temporary PostgreSQL 17 database with all migrations, a
  28-route production build, 32 Playwright tests, production doctor, and `git diff --check`. The
  targeted browser test proved one card, both provider links, one grouped confirmation request, and
  removal of both mirrored rows. Database verification proved two manual decisions and provider
  mappings but only one canonical feed item after confirmation.
- Production currently has zero raw actionable review rows and zero grouped review decisions, so no
  live review decision was available or made. The optimized build was deployed through the existing
  hidden `TS New Music Radar Web Application` task. Loopback health passed, and a cache-busted live
  browser load displayed the new grouped-count wording.
- Production doctor is READY: PostgreSQL is connected, all 31 migrations are applied, the loopback
  application is healthy, and no provider lease, cooldown, stale lock, or recent Spotify 429 is
  present. The shared Showcase test database on port 5433 lacks migration 0030 and can log a
  missing-column warning on unmocked E2E status requests; scanner integration and production use
  current databases, and all E2E tests passed.
- No provider request, playlist write, review decision, scheduler invocation, credential change, or
  `.env` change was made for this repair.

## Keep-Awake Validation Correction (2026-08-28)

- The one-time 02:50 PDT task woke Windows at 02:49:38, ran at 02:50 with result 0 and zero missed
  runs, and the minute scheduler resumed. Normal production Spotify work then resumed without
  overlap, cooldown, lease, 429, or provider errors. This live-validates wake from ordinary signed-in
  sleep. The four normal maintenance triggers were not changed.
- The missing validation JSON was caused by `wake-validation-cli.ts` running `powercfg /requests`
  before it acquired the keep-awake helper. This PC restricts that query to administrators, although
  `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` itself works for the normal limited
  scheduled-task identity.
- Keep-awake proof no longer depends on `powercfg`. Each owner now has a durable run ID and record
  under `%LOCALAPPDATA%\TSNewMusicRadar\logs\keep-awake`. The record contains the owner and helper
  process IDs, request reason and phase, requested and activated timestamps, release request and
  completion timestamps, final released state, release reason, and abnormal-exit recovery fields.
  A single exclusive owner record rejects overlap. An exited owner is recovered only after its old
  helper is confirmed gone, so a replacement cannot overlap it.
- Production maintenance passes the current work reason into the record. It acquires the helper only
  for due work or a scheduler-approved wait of at most 15 minutes for known capacity, updates the
  phase as the decision changes, and releases in `finally` as soon as work drains, becomes
  non-runnable, fails, or reaches the four-hour ceiling.
- The helper now uses a graceful release signal, records activation after the Windows API succeeds,
  clears `ES_SYSTEM_REQUIRED` in `finally`, writes release evidence, and exits if its owner process
  disappears. A stale owner record is marked `recovery_pending` while an old helper still exists and
  `recovered_after_abnormal_exit` after it is safely gone.
- `powercfg /requests` remains an optional secondary observation. Administrator or access-denied
  results are recorded as informational and never prevent activation or make validation fail.
- A two-second non-provider validation under the current non-admin identity passed at 14:02 PDT. Run
  ID `6fe5b8e8-6bac-41c2-9e13-b948f5b0a170` recorded helper PID 42336, activation at
  21:02:44.068Z, requested release at 21:02:45.611Z, completed release at 21:02:45.816Z, final state
  `released`, and no remaining owner. Both optional `powercfg` observations reported informational
  `access_denied`. No database, provider, scheduler, or playlist path was imported or invoked.
- Task Scheduler Operational history remains disabled. Enabling it was attempted without elevation
  and Windows returned access denied. From an Administrator Terminal, run:
  `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`.
- The reusable one-time validation registration now requires an explicit future `-RunAt` value and
  keeps the direct hidden `conhost.exe --headless node.exe --import tsx` action, limited-user
  principal, `WakeToRun`, `StartWhenAvailable`, and `IgnoreNew`. It does not alter production
  triggers.

## Upcoming Feed Maturity Correction (2026-08-28)

- Root cause: `feed_items.state` captured `candidate.isUpcoming` only when a discovery was first
  inserted. The conflict path was intentionally idempotent and never revisited that state, so an
  item could remain `upcoming` after its effective canonical release date passed.
- The recurring scheduler now matures only rows still in `upcoming` at the start of every normal
  tick. It uses the Pacific production calendar date and moves a row to `new` when its effective
  canonical release date has arrived or exact stored Spotify availability says the track is
  playable in the US. Saved, listened, dismissed, and review states are never overwritten.
- This also handles released preview tracks from future-dated albums without moving unreleased
  siblings. The summary card now counts only actual `upcoming` rows within the next 30 days.
- A fresh pre-correction backup is at
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-28T21-19-17-273Z.dump`.
  It is 38,015,992 bytes with SHA-256
  `077A459C4971AC2B727D3F25B4942B77E2B9C09D8BDEBE02F6689EC31B16B199`; PostgreSQL 17
  `pg_restore --list` verified 525 table-of-contents lines.
- The natural minute scheduler applied the correction without a manual provider scan. It moved 28
  rows: 22 whose effective release dates had passed and 6 already-playable preview tracks. A second
  pass was a no-op. Production now has 1,705 `new`, 6 `upcoming`, and zero eligible stale upcoming
  rows.
- The six retained rows are future-dated and not stored as playable: `Worship` and `Prayers`
  (September 11), `More! More! More!` and `what do i have to do?` (September 25), and `LIEBE` and
  `Stay` (October 23). The live API and in-app browser both report 6 total Upcoming items and 4
  within the next 30 days.
- No Apple Music or Spotify request was made solely for this repair. No playlist write, review
  decision, provider schedule, maintenance wake trigger, credential, or `.env` value was changed.
- The full validation result for this repository state is: formatting passed; lint passed with zero
  warnings; typecheck passed across all six projects; 74 unit files and 521 tests passed; 28
  integration files and 154 tests passed against a temporary PostgreSQL 17 instance on port 5434;
  the production build generated all 28 pages and routes; and all 32 Playwright tests passed. The
  broad navigation Playwright test was made self-contained after it exposed an existing dependency
  on leftover OAuth state in the shared test database.
- Doctor is READY with all 31 migrations applied, PostgreSQL connected, no stale lock, active
  provider lease, or cooldown, and the web health endpoint responding on `127.0.0.1:3000`. The
  production web build was restored through `TS New Music Radar Web Application`; the task remains
  the hidden long-running supervisor with zero missed runs.

## Followed-Artist Removal Repair (2026-08-28)

- Root cause: the trash button changed only browser memory and never called a server route or
  updated `artist_follows`. The watchlist query also returned inactive follow rows, so a reload
  restored both newly removed artists and ten historical inactive rows.
- `DELETE /api/artists/[id]` now idempotently sets the local follow inactive while preserving the
  canonical artist, provider mappings, releases, evidence, and history. Queued Spotify scheduler
  work for that artist is blocked with `artist_not_followed`; leased work is not interrupted.
- The watchlist API now returns only active follows. A Spotify followed-artist import leaves an
  inactive canonical artist unselected by default, preventing a routine import from silently
  reactivating a local removal. The user can still explicitly select that candidate to re-add it.
- A fresh backup made before the live removal is at
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-28T23-21-56-143Z.dump`.
- The previously requested `barking continues` removal was applied through the new loopback route.
  Active follows changed from 583 to 582, the artist is absent from a fresh API response and full
  browser reload, and one queued Spotify work item was blocked. No canonical evidence was deleted.
- The existing hidden web supervisor recovered from a controlled web-process stop and started the
  verified production build with a new PID. Loopback health and production doctor are READY with
  all 31 migrations, no stale lock, provider lease, cooldown, or recent Spotify 429.
- No Apple Music or Spotify provider request, playlist write, provider schedule change, credential,
  or `.env` change was made for this repair.

## System Status Contract Repair (2026-08-28)

- Root cause: `/api/system/status` was healthy and returned HTTP 200, but the browser's shared
  Spotify scheduler schema did not recognize the current `track_resolution` work type. Production
  reported that value in `recentWork`, so Zod rejected the whole response and the page displayed
  the generic load error.
- The browser contract now accepts `track_resolution` in active and recent work, backlog counts,
  and request counts. The detailed scheduler view also reports the track-resolution backlog and
  request total.
- Playwright now injects a production-shaped `track_resolution` status response and proves the
  System status view loads without the error. The older scan-history fixture was updated to the
  same complete scheduler contract.
- The historical migration-upgrade integration test now has a 15-second timeout. Applying its 17
  historical migrations consistently exceeded Vitest's five-second default on Windows Docker; the
  assertions and production behavior are unchanged.
- The verified build was deployed through the existing supervisor. The web child changed from PID
  31996 to PID 45676, `/api/health` returned `ok`, and a cache-busted in-app browser load showed the
  complete System status view with zero `Status could not be loaded.` messages and zero browser
  error logs.
- No database row, provider state, playlist, schedule, credential, or `.env` value was changed.

## Validation

- `pnpm format:check`: passed
- `pnpm lint`: passed with zero warnings
- `pnpm typecheck`: passed across all six workspace projects
- `pnpm test`: 75 files and 525 tests passed. Maintenance coverage directly asserts keep-awake
  release, failure cleanup, absolute runtime cutoff, dynamic-wake deduplication, Thursday and Friday
  broad-work suppression, Saturday broad eligibility, Apple-priority precedence, cooldown
  enforcement, optional `powercfg` denial, single-owner enforcement, crash recovery, bounded
  near-term waits, and durable activation and release evidence.
- `pnpm test:integration`: 28 files and 155 tests passed against an isolated PostgreSQL 17 service
  on port 5434 with all 31 migrations. Production port 5432 was not used by the tests.
- `pnpm build`: passed, including the current API and system-status routes
- `pnpm test:e2e`: 32 Playwright tests passed, including production-shaped
  `track_resolution` status data and the complete scan-history scheduler contract
- `pnpm run doctor`: READY, with PostgreSQL connected, all 31 migrations applied, no stale locks,
  no active provider lease or cooldown, and `127.0.0.1:3000` healthy. With pnpm 11, bare
  `pnpm doctor` invokes pnpm's package-manager diagnostic rather than the repository script.
- `git diff --check`: passed
- In-app browser smoke: a cache-busted System status reload rendered Database, provider, scanner,
  and scheduling status with no load-error text and no browser error logs.

## Remaining Verification

- Wake from signed-in sleep and resumption of production work are live-validated. The corrected
  non-admin helper activation, durable evidence, graceful release, optional access-denied handling,
  and absence of a leftover owner are also live-validated while Windows remained awake.
- One final sleep test is needed only to prove the corrected helper prevents sleep for the entire
  hold interval under the scheduled Limited identity. Register a future one-time validation with an
  explicit `-RunAt`, put the signed-in PC into ordinary sleep before it, and inspect
  `wake-validation-latest.json` plus the matching keep-awake run record afterward. Do not change or
  move the four production maintenance triggers.
- Task Scheduler Operational history can be enabled only from an Administrator Terminal on this PC
  with `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`.
