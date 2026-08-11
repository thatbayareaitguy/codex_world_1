# AI Handoff

Updated: 2026-08-10 18:24 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Current checkpoint: latest branch `HEAD`; activation handoff is committed
- Upstream: current branch tracks `origin/codex/release-radar-hardening`
- Worktree before this update: tracked files clean; unrelated `outputs/` untracked and excluded
- Database: PostgreSQL healthy; all 29 forward migrations applied

## Current Milestone

Recurring local production operation is active and has completed live broad Spotify work through the
unified scheduler. Repository defaults remain disabled and no production settings are committed.

## Operational State

- Protected local flags enable Apple Music, recurring discovery, the Spotify scheduler, Spotify
  playlist writes, and only playlist `4l6LaMPL6duulmFe3hRR4Y`.
- MusicBrainz, Reddit, SoundCloud automation, and SoundCloud manual links are disabled in the
  recurring task process.
- Windows task `TS New Music Radar Recurring Discovery` is enabled, hidden, wakes every minute, and
  uses `conhost.exe --headless node.exe --env-file ... --import tsx`. It does not launch PowerShell
  or pnpm. Overlap is rejected, missed starts run when available, WakeToRun is enabled, and the Task
  Scheduler service starts automatically.
- The two expired one-time Spotify campaign tasks are disabled.
- Next full Apple job: Thursday, 2026-08-13 at 21:00 PDT. Next Apple catch-up: Friday,
  2026-08-14 at 09:00 PDT. No missed Apple recovery is currently due.
- Scheduler phase: `broad_spotify`; Apple-priority queues are empty; playlist inbox has zero pending
  operations; no Spotify cooldown or active lease exists.
- Activation sample: five broad artists persisted successfully, due artists decreased from 583 to
  578, and artist-reconciliation backlog decreased from 431 to 428. The scheduler recorded nine
  broad requests and no HTTP 429.

## Verified

- Production doctor is READY with Apple, recurring discovery, Spotify scheduling, fixed-target
  playlist writes, and both Spotify playlist modification scopes enabled.
- The scheduler task completed a manually started tick and subsequent automatic minute wakes with
  task result `0`.
- The web application was restarted under a new hidden process while PostgreSQL and Task Scheduler
  remained active. The recurring task continued, and the Discovery Feed returned without an error.
- The authorized playlist remains public and non-collaborative with 1,009 unique tracks: 1,008
  app-managed and one user-added track. The read-only preview proposed zero additions and found zero
  duplicate track IDs.
- The cached Custom Order requires zero reorder moves. It remains newest release date first with
  Spotify album groups ordered by disc and track number. Date Added provenance was not changed.
- The preview made one snapshot-aware playlist metadata read and no write. No other playlist was
  configured or accessed during activation.
- Targeted unit tests: 39 passed across four files. Targeted PostgreSQL integration tests: 32 passed
  across four files. Browser smoke passed.

## Implemented But Not Yet Live-Observed

- Thursday full Apple discovery, Apple-priority Spotify resolution, and automatic guarded export in
  one unattended production workflow.
- Friday Apple catch-up, priority resolution, and automatic guarded export.
- Automatic broad-checkpoint export was not needed in the activation sample because no new eligible
  tracks were found. Its enabled path remains covered by unit and PostgreSQL integration tests.
- Windows registration is persistent, StartWhenAvailable, and backed by the automatic Task Scheduler
  service. An actual operating-system reboot was not performed during activation.

## Known Diagnostics And Risks

- The export preview reports canonical-candidate sequence and canonical-release grouping diagnostics
  separately from Spotify Custom Order. Those counts are not Custom Order moves; the actual cached
  playlist order requires zero moves.
- Spotify limits remain unpublished. All work must continue through the shared PostgreSQL request
  gate, daily budgets, endpoint reserves, and persisted cooldown.
- A crash between a provider write and local snapshot persistence may require one complete playlist
  reconciliation read after restart.

## Immediate Next Step

Observe the recurring broad worker through its daily boundary, then verify the unattended Thursday
and Friday workflows at their scheduled times. Do not bypass the scheduler, request gate, playlist
cache, or fixed playlist target.

## Deferred

- Live observation of a nonempty Apple-priority queue
- Live Thursday and Friday automatic export results
- Actual Windows reboot validation
- Deep historical reconciliation and inactive providers
