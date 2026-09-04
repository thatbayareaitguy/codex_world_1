# AI Handoff

Updated: 2026-09-02 21:14 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Current reliability-goal starting HEAD and upstream:
  `5845943310cd0e6430b52009952feec78e8b2351`
- The tracked worktree was clean at goal start. The feed/review work described as uncommitted in the
  goal had already been coherently committed in `8d3c8ffc8e341c6bf713ef68818388603e903e32`
  (`fix: group mirrored release reviews`). It was preserved and extended, not reverted or
  duplicated.
- `outputs/` is unrelated, remains untracked, and is excluded from the intended commit.
- No secret or `.env` file was changed.

## Production Reliability Completion (2026-09-02)

### Web application watchdog

- Root cause of the August 29 through September 2 dashboard outage: the web supervisor and child
  process had both ended without a logged application crash, leaving stale PID files. The existing
  Windows task had only an at-logon trigger, so Task Scheduler had no reason to launch the
  supervisor again while the same login session remained active.
- `TS New Music Radar Web Application` now has `WebAtLogon` plus an awake-only `WebWatchdog` trigger
  every five minutes. It remains hidden, `IgnoreNew`, `StartWhenAvailable`, restart-on-failure, and
  `WakeToRun=false`. Its action remains direct:
  `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\web-supervisor-cli.ts"`.
- Registration at 20:53 PDT recovered the already-offline application at 20:54:25 without a login.
  A controlled stop then terminated only the verified supervisor PID 62232 and web PID 42640.
  Doctor correctly changed to `ACTION_REQUIRED`, reported the app offline and port 3000 free, and
  identified the supervisor as stopped and task as registered. The 20:59:21 watchdog run restored
  health at 20:59:27 without manual task invocation. The recovered tree contained one headless
  console host, one supervisor PID 50436, and one Next.js child PID 65372 bound to
  `127.0.0.1:3000`; there was no duplicate supervisor.
- Doctor now calls the health endpoint first. A free port without a responding application is
  `ACTION_REQUIRED`, not `READY`; a non-health process occupying the port is an error. Offline
  diagnostics include the stale/live supervisor PID state and whether the Windows startup task is
  registered, disabled, missing, or unavailable.

### Capacity-aware broad Spotify wake

- The maintenance decision now treats broad Spotify work that is otherwise eligible but blocked
  only by the rolling Artist Albums allowance the same way as priority capacity waits. If capacity
  returns within 15 minutes, the existing single keep-awake owner holds
  `ES_SYSTEM_REQUIRED`. For a longer wait it releases power and maintains one
  `DynamicCapacityWake` ten minutes before the database-calculated next capacity time. Daily artist
  and request ceilings, provider cooldowns, the 80-call trailing allowance, 20-call priority
  reserve, queue priority, discovery behavior, and playlist safeguards are unchanged.
- The capacity time must itself fall on Saturday through Wednesday in Pacific time. A natural
  Wednesday-night tick initially exposed that the first implementation would schedule a Thursday
  morning wake even though broad work is disabled Thursday and Friday. The guard was added before
  commit, and the next ordinary minute tick removed that trigger at 21:10:26 with result 0. The
  maintenance task returned to exactly its four fixed triggers and next runs Thursday at 20:50.
- A live task-only test used future times and made no provider request: the first update created one
  `DynamicCapacityWake`, the second replaced it while the count remained one, and cleanup removed
  it. Throughout the test the fixed IDs remained `BroadMorningWake`, `BroadEveningWake`,
  `ThursdayAppleWake`, and `FridayCatchupWake`. Final state has zero temporary dynamic wakes,
  `WakeToRun=true`, `IgnoreNew`, and `StartWhenAvailable=true`.
- Offline loop tests prove a near-term broad wait acquires the shared keep-awake owner with reason
  `broad_capacity_wait`, releases it when work becomes non-runnable, and uses the same durable
  activation, owner, helper, reason, phase, release, and abnormal-recovery evidence as the already
  live-validated maintenance helper. A natural capacity-bound sleep cycle is still needed to prove
  this new broad decision end to end; no provider work was started solely for validation.

### Current task and production evidence

- At final task inspection the maintenance task was enabled and had last result 0 at 20:50 PDT with
  zero missed runs. The recurring minute task was enabled, awake-only, and returning 0. One minute
  trigger was reported missed while another bounded invocation was active; `IgnoreNew` prevented
  overlap and later ticks continued normally. The web task was enabled and running with zero missed
  runs. While its long-running supervisor is healthy, later five-minute triggers are intentionally
  rejected by `IgnoreNew`; Windows exposes that no-overlap decision as `0x800710E0` even though the
  supervisor remains running and health is `ok`. This is not a child-process failure or missed run.
- Production PostgreSQL remains healthy on `127.0.0.1:5432`, all 31 migrations are applied, and the
  Compose `db` service still has `restart: unless-stopped`. Doctor is `READY` after watchdog
  recovery. There are no stale locks, active provider leases, active cooldowns, or Spotify 429s in
  the last 24 hours.
- Read-only scheduler status at 20:59 PDT showed phase `broad_spotify`, 582 target artists, 561 due,
  21 checked in the prior 24 hours, 52 of 80 trailing Artist Albums calls used, 8 broad calls then
  available, and zero pending playlist additions. The last full Apple workflow completed 583 of
  583 with zero failures; the last catch-up also completed 583 of 583 with zero failures. The next
  normal workflows remain Thursday September 3 at 21:00 and Friday September 4 at 09:00 Pacific.
- The exports dashboard reported 0 ready, 1,278 exported feed records, and 112 system-waiting
  blocks. It did not report a user-actionable playlist block. No provider request or playlist write
  was initiated for this reliability validation.
- Browser smoke rendered the recovered feed, exports page, and System Status page. The web server's
  ignored `.env` currently has Spotify and dormant MusicBrainz enabled but does not enable Apple or
  the scheduler; the protected production scheduler environment correctly has Apple and both
  schedulers enabled and MusicBrainz disabled. This pre-existing configuration split explains why
  provider enabled labels in System Status do not represent the production task. No `.env` was
  changed in this pass. Aligning the web-only flags is a separate configuration correction.
- Task Scheduler Operational history is still disabled. The current limited identity can inspect
  the setting but cannot enable it, and `powercfg /waketimers` likewise requires elevation. From an
  Administrator Terminal, enable future task event history with
  `wevtutil sl Microsoft-Windows-TaskScheduler/Operational /e:true`. Neither limitation blocks
  normal task execution.

### Validation

- Formatting passed. Lint passed after correcting one unused local variable. TypeScript passed
  across all six workspace projects. Unit tests passed: 75 files, 531 tests. PostgreSQL integration
  tests passed against an isolated PostgreSQL 17 container on port 5434: 28 files, 157 tests. The
  production build generated all 28 pages and routes. Chromium passed all 32 tests against a second
  isolated port-5434 database. Both temporary containers were verified by exact name and port and
  removed; production and Showcase databases were not touched.
- Final Doctor, health, task snapshot, migration count, and `git diff --check` passed immediately
  before commit. The commit and push result are recorded in the final task report.

## Review Completion And Broad Spotify Coverage Audit (2026-08-29)

### Review classification and workflow

- Production currently has 6 user-actionable review groups, all Spotify candidate records for
  Fairlane: `Back 2 Life`, `Everybody Knows`, `Hero`, `Euphoria`, `Best You Could`, and `Colors`.
  Each already has an exported Spotify track, so these are durable match-quality decisions but are
  not currently blocking a playlist addition.
- The current export classification is 114 blocked tracks waiting on guarded Spotify resolution,
  0 user-actionable export blocks, 0 terminal or no-equivalent blocks, 0 deferred groups, and 0
  stale blocks. Before the repair, 113 were waiting and one historical `SEROTONIN` record was stale.
- `SEROTONIN` had an ISRC, active followed artist, and confirmed Spotify artist identity but no
  Spotify track and no resolution work. Its evidence originated from a historical non-Apple path,
  while automatic repair seeding required an Apple candidate. Repair seeding now preserves the
  Apple path and also accepts any canonical, non-dismissed followed track with a valid ISRC and a
  confirmed Spotify artist mapping. It does not enable or call MusicBrainz. The natural scheduler
  reconciled `SEROTONIN` into the guarded queue; no manual provider command was run.
- Needs Review now contains only human decisions. System-waiting, terminal, and stale records have
  separate expandable classifications with explicit reasons. Each human card shows the recommended
  candidate, stored Spotify and Apple artwork or an honest missing-artwork placeholder, artist,
  release, type, date, track list, provider links, blocking reason, evidence, and confidence.
- Durable actions are `Confirm recommended candidate`, `Choose another candidate` through a verified
  Spotify track URL, `Retry matching`, provider-specific `Keep separate`, `No Spotify equivalent`
  when no Spotify candidate exists, and `Defer 7 days`.
- Confirming stored Spotify evidence changes the candidate to a manual exact match and marks a
  completed broad playlist checkpoint pending. The existing scheduler performs the later guarded
  preview and fixed-target export. The browser request never writes the playlist. Exact track-link
  confirmation and retry still queue guarded resolver work first.
- No review decision was made during this goal, so 0 tracks became newly eligible. The six Fairlane
  groups remain for the user to decide.

### Artist Albums request breakdown

The 759 Artist Albums requests in the audited August 14 through August 29 window all succeeded with
zero 429s and zero failed requests:

| Queue                        | Requests |             Unique artists |   Repeated-artist requests | Work rows |
| ---------------------------- | -------: | -------------------------: | -------------------------: | --------: |
| Apple priority and catch-up  |      324 |                        145 |                        179 |       307 |
| Broad recurring artist scans |      182 |                        182 |                          0 |       182 |
| Artist reconciliation        |       25 |                         25 |                          0 |        25 |
| Release and track repair     |      228 |                         15 |                        213 |       120 |
| Total                        |      759 | not additive across queues | not additive across queues |       634 |

Daily Artist Albums use was: Aug 14 61, Aug 15 69, Aug 16 38, Aug 17 72, Aug 18
80, Aug 19 80, Aug 20 49, Aug 21 60, Aug 22 39, Aug 25 71, Aug 26 60, Aug 28
15, and Aug 29 65. Broad completed artists were: Aug 15 10, Aug 16 17, Aug 17 36,
Aug 18 33, Aug 19 34, Aug 25 26, and Aug 26 26. Aug 22 and Aug 29 were eligible
broad days but priority work consumed the available Artist Albums capacity. Aug 23 and Aug 24 were
the previously documented host-sleep gap. Thursday and Friday broad exclusion remains intentional.

- The base broad scan itself used 182 Artist Albums requests plus 10 OAuth requests for 182 artists,
  or 1.05 requests per completed broad artist. Including 11 downstream recurring release-detail
  calls gives about 1.12. Broad scanning is not intrinsically request-heavy.
- The main displacement was repair work. Daily ISRC misses correctly requeue for a later exact check,
  but each miss also reopened already completed `single` and `album` fallback searches. In this
  window, `single` used 124 requests for 63 work rows and `album` used 89 for 57, exposing 93 repeated
  fallback Artist Albums calls.
- Automatic ISRC cascades now leave completed fallback work completed. An explicit user `Retry
matching` still reopens it. This removes the proven daily fallback churn while keeping manual
  recovery and the daily exact-ISRC check.
- The +24-hour base due-date calculation is correct as a due-order mechanism. It does not guarantee
  that every due artist can run within 24 hours when higher-priority queues consume the same
  endpoint budget.
- The observed rate is about 26 artists per broad day that actually ran, or about 20.2 across all
  eligible operating days including zero-capacity days. At those rates, full 582-artist coverage is
  about 31 to 40 calendar days. A two-week cycle requires about 59 artists on each of ten broad days,
  nearly the 60-call daily broad Artist Albums ceiling, so it is not realistic while priority and
  repair queues share that capacity.
- Ranked next options by safety are: first, keep the implemented completed-fallback guard; second,
  consider a longer backoff such as three to seven days for repeated ISRC no-match rows; third,
  consider a protected base-scan capacity share. The second option offers the next clearest request
  saving but adds delayed detection risk and was not implemented without a product decision. Budgets,
  queue priorities, provider cadence, and production schedules were not changed.

### Verification and operational state

- The development runners now honor an explicit `TEST_DATABASE_URL` without also starting the
  default Compose test service. Playwright accepts `RADAR_E2E_DATABASE_URL`. This allowed the full
  test suites to use a temporary PostgreSQL 17 container on `127.0.0.1:5434` without touching the
  Showcase database on port 5433.
- A controlled application restart activated the new build. `app:down` also stopped the production
  database service by design; `app:up` immediately restored PostgreSQL and the web supervisor. The
  persistent database volume was preserved, health returned `ok`, doctor reports all 31 migrations,
  and there is no evidence of data loss or a stale lock.
- Production doctor is READY. Current scheduler evidence at 14:25 PDT shows automatic mode, no
  active lease or cooldown, no Spotify 429 in the last 24 hours, Artist Albums at 80 of 80, priority
  reserve at 0 of 20 remaining, playlist inbox completed, and zero pending playlist operations.
- Browser smoke verified 6 human review cards, recommended-candidate labels, Spotify links, stored
  artwork, Apple comparison placeholders where Apple evidence is absent, all durable action controls,
  114 separate system-waiting rows with guarded-queue reasons, and zero stale rows.
- Validation passed: formatting, lint with zero warnings, TypeScript across six projects, 75 unit
  files with 525 tests, 28 PostgreSQL integration files with 157 tests, the 28-route production
  build, 32 Chromium tests, production doctor, migration inspection, browser smoke, and
  `git diff --check`.

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
