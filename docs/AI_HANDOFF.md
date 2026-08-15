# AI Handoff

Updated: 2026-08-15 12:23 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting HEAD and upstream for this milestone: `2ee8596670bcb8532b6d0bc8e218c711ec3be4d9`
- The milestone commit includes automatic Windows web startup and recovery plus the preserved feed
  data-source and History and Schedules work that was already in progress.
- Unrelated `outputs/` remains untracked and excluded. No secret or `.env` change is included.

## Startup Root Cause And Resolution

- PostgreSQL already recovered through Docker Desktop, and recurring discovery already ran through
  its separate Windows task. The site remained offline because no startup task relaunched Next.js.
- The stale runtime PID record contained `79372`, which no longer existed. Prior logs showed a clean
  web startup and no application crash.
- Windows task `TS New Music Radar Web Application` is now registered for the current user's logon.
  It is enabled, hidden, StartWhenAvailable, non-overlapping with `IgnoreNew`, unlimited in execution
  duration, and configured for three task-level failure restarts at one-minute intervals.
- Exact action:
  `C:\Windows\System32\conhost.exe --headless "C:\Program Files\nodejs\node.exe" --import tsx "C:\Users\taysh\Documents\Codex\codex_world_1\apps\scanner\src\web-supervisor-cli.ts"`
- The recurring action does not use PowerShell, `pnpm.cmd`, `cmd.exe`, a `.ps1` runner, an environment
  file argument, or a credential argument. Registration and removal are one-time PowerShell
  workflows and are safe to repeat.
- The Node supervisor retries Docker Compose and PostgreSQL readiness every 10 seconds for at most 60
  attempts per task run. It applies pending migrations directly through Node before every web start.
  A bounded failure exits nonzero so Task Scheduler can apply its restart policy.
- Production Next.js starts only on `127.0.0.1:3000`. A responding health endpoint prevents a
  duplicate start. Three consecutive failed health checks or an unexpected child exit trigger a
  bounded restart backoff.
- Dead or invalid web PID records are removed before startup. A separate supervisor PID claim
  prevents duplicate supervisors, and removal terminates only the exact repository-scoped
  supervisor process. No process is killed solely because an old web PID number exists.

## Verified Startup Behavior

- Registration succeeded twice without creating duplicate tasks. Removal succeeded, repeated
  removal was a no-op, and final re-registration succeeded.
- After the corrected final registration, one supervisor and one loopback listener existed.
- Controlled recovery stopped web PID `37396`. The supervisor reapplied migrations, started PID
  `43408`, and restored `http://127.0.0.1:3000/api/health` within the two-minute verification bound.
- A second manual task invocation left PID `43408`, the single supervisor, and the single loopback
  listener unchanged.
- The task action's `conhost.exe` and Node processes reported `MainWindowHandle=0`. No visible console
  window appeared.
- Docker PostgreSQL is healthy on loopback, and the production database has all 29 migrations.
- The in-app browser loaded the real database-backed Discovery Feed, navigated to History and
  Schedules, and reported no console errors.
- No Windows reboot was performed.
- The final application build was loaded through another controlled stop of verified web PID
  `11976`. The same supervisor PID `14976` recovered the application as web PID `38020`, which is
  the only listener on `127.0.0.1:3000`. Both processes still report no visible window.

## Spotify Match And Interface Corrections

- Apple-priority and Apple catch-up Spotify artist work now always refreshes catalog offset zero.
  Ordinary reconciliation work still resumes its persisted deep cursor. Newly selected releases
  continue to queue source-scoped release-detail work, and those detail items remain part of the
  priority queue drain before playlist export becomes ready.
- The latest completed export contained 171 `missing_spotify_match` operations across 50 artists.
  Exactly one completed priority artist check for each of those 50 artists was safely requeued.
  No duplicate artist was queued and no provider request was made manually.
- Review updates now have an isolated `/api/feed-items` rate-limit bucket with capacity for 300
  updates per minute. Unrelated API polling no longer consumes review-confirmation capacity.
- Spotify availability now treats validated Spotify source evidence as a match even when the older
  availability row is absent. The Available database filter uses the same rule, and the misleading
  per-card `Spotify unavailable` label was removed.
- The active source list now shows Apple Music and Spotify with check marks based on persisted
  operational evidence, and MusicBrainz is omitted from active source and mapping controls.
- The artist toolbar now displays `Followed Artist Count: 593`; unit-facing browser coverage verifies
  that the value changes immediately after an artist is added or removed.
- Real-browser verification found 1,219 records with the Spotify Available filter, zero false
  `Spotify unavailable` labels, both active provider labels, no MusicBrainz controls, and the 593
  artist counter.

## Validation

- `pnpm format:check`: passed
- `pnpm lint`: passed with zero warnings
- `pnpm typecheck`: passed across all six workspace projects
- `pnpm test`: 66 files and 479 tests passed
- `pnpm test:integration`: 27 files and 143 tests passed after provisioning `db-test` and applying
  every migration
- `pnpm build`: production Next.js build passed with 27 routes
- `pnpm test:e2e`: 30 Playwright tests passed
- `pnpm doctor`: READY, including database connection, 29 migrations, and port 3000
- `git diff --check`: passed

## Current Operational State

- Thursday Apple full scan `c35ab414-6c2a-4ae4-ad1a-6c80c45a52bc` completed at 21:23 PDT with
  583/583 artists completed and zero failures.
- Friday Apple catch-up batch `70983a9b-dd3f-4e85-8a45-b66754e01744` completed at 09:22 PDT with
  583/583 artists completed and zero failures. The next full and catch-up runs are scheduled for
  August 20 at 21:00 PDT and August 21 at 09:00 PDT.
- Discovery phase is `apple_priority` with 50 deliberately requeued recovery artists and one broad
  release-detail item still queued. Ten broad artists were checked on August 15 before recovery was
  prioritized.
- Spotify Artist Albums usage is 80/80. The next recorded capacity return is August 15 at 21:25 PDT.
  The last 24 hours contain 80 Artist Albums, 11 album-detail, 30 playlist-read, 45 playlist-write,
  and 33 OAuth or other requests.
- No Spotify HTTP 429 occurred in the last 24 hours. No cooldown or active request lease exists.
- Playlist inbox is completed. Export `9c081b73-4471-425d-95a8-27d6dcea284e` added 5 tracks, found
  1,050 already present, skipped 341, and failed 0. Another checkpoint will follow the recovery
  queue after capacity returns.
- `TS New Music Radar Recurring Discovery` remains enabled, hidden, ready, and most recently returned
  result `0`. Its exported XML SHA-256 remains
  `D3E1460F536DC315E74C701375BB3EB0AE95518D4AB907C25EA890F8C586C248`, unchanged from the pre-task
  baseline.
- Normal shell defaults keep recurring provider execution disabled. The existing recurring task
  continues to use its separate protected production environment. No manual Spotify or Apple
  request was made during this startup task.

## Missing Spotify Playlist Mapping Diagnosis

- Ten user-supplied Apple discoveries that are available on Spotify were traced through persisted
  catalog, canonical-track, feed, scheduler, and playlist-export records without calling either
  live provider.
- All ten were skipped by the latest playlist export as `missing_spotify_match`. Their supplied
  Spotify track IDs were absent from `track_external_ids`; this was not a playlist API failure.
  Every artist had a confirmed Spotify artist mapping and a completed Apple-priority or catch-up
  Spotify job.
- Those priority jobs ran in `reconciliation` mode with `spotifyNewReconciliationCycle=false`, so
  they resumed the old deep catalog cursor. The ten jobs fetched offsets 10, 20, or 30 and advanced
  them to 20, 30, or 40 instead of refreshing offset 0, where newly released albums appear.
- `Keep Control` was later found when its broad daily scan correctly fetched offset 0, but its
  release-detail work was still queued when the playlist export ran, so the track ID was not yet
  available to the exporter. The other nine supplied releases were not present in the stored
  recent Spotify catalog at all.
- The latest completed export planned 1,055 eligible tracks, added 5, found 1,050 already present,
  and skipped 341 with zero failures. Skip reasons were 171 `missing_spotify_match`, 168 duplicate
  appearances, and 2 uncertain matches. The 171 missing-match rows cover 50 artists; 170 have a
  confirmed Spotify artist mapping and a completed priority job after discovery, while 120 can be
  directly tied to a priority scan at a nonzero catalog offset. Fifty-six were first seen in the
  current weekly cycle. These counts show a broader pattern, but do not prove that every one of the
  171 tracks exists on Spotify.
- The correction is implemented and tested. Apple-priority work refreshes Spotify offset zero while
  preserving the separate deep reconciliation cursor. Existing release-detail work remains ahead of
  artist work in priority ordering and counts toward queue drain. The 50 affected artists are queued
  for automatic recovery once capacity returns. The ten supplied Spotify IDs remain unmapped until
  that queued recovery executes.

## Deferred

- Completion of the 50-artist missing-match recovery after Spotify capacity returns
- Verification of which of the ten supplied tracks map and enter the next automatic playlist export
- Actual Windows restart or logoff validation
- Database backup refresh after the last recorded 2026-08-04 backup
