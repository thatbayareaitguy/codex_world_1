# AI Handoff

Updated: 2026-08-08 17:51 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting checkpoint: `9f0165c` (`docs: sync scheduler handoff`)
- Current implementation checkpoint: this commit (`fix: batch recurring Spotify playlist delivery`)
- Milestone: first-week bootstrap validation and bounded broad-work playlist delivery
- Upstream: synchronized with `origin/codex/release-radar-hardening` after this checkpoint push
- Worktree: clean except unrelated untracked `outputs/`, which remains excluded
- PostgreSQL: healthy with 28 forward migrations; no migration was required for this milestone

## Verified Capabilities

- Thursday 9:00 PM Apple scan and Friday 9:00 AM catch-up are durable local-time jobs in
  `America/Los_Angeles`. A later full scan satisfies a missed same-week catch-up without a redundant
  Apple request.
- A due Apple job is claimable during Spotify cooldown. Its Spotify work waits durably behind
  unresolved Thursday priority.
- Thursday and Friday flow automatically from Apple discovery to Apple-priority Spotify resolution
  and then the existing guarded exporter. No interactive export command is required in enabled local
  production operation.
- Export is add-only and restricted to playlist `4l6LaMPL6duulmFe3hRR4Y`. It verifies authentication,
  exact target identity, ownership, private and non-collaborative state, exact or manually confirmed
  playable tracks, provider presence, and the durable export ledger.
- New tracks prepend at position zero in deterministic discovery order. Existing tracks are never
  removed or reordered, and user-added tracks remain untouched.
- Restart and expired-cooldown reconciliation restore a pending export or priority phase before broad
  Spotify work. A valid cooldown is never cleared or probed.
- Repository defaults remain safe. Automatic writes require process-local production settings:
  `DISCOVERY_SCHEDULER_ENABLED=true`, `SPOTIFY_SCHEDULER_ENABLED=true`,
  `SPOTIFY_PLAYLIST_WRITES_ENABLED=true`, and the exact allowed playlist ID above.
- UI status distinguishes Apple resolution, playlist readiness, exporting, cooldown pause, completion,
  broad backlog, budgets, and next scheduled jobs.
- Saturday-Wednesday broad discoveries create one durable playlist checkpoint and use the existing
  guarded exporter at a queue, rolling-window, local-day, Artist Albums, or cooldown boundary. This
  avoids one write cycle per artist while ensuring export precedes a scheduler yield or later broad
  work.

## Operational State

- Scheduler database mode: `automatic`; local process capabilities still default disabled.
- Bootstrap campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94` remains
  `completed_with_spotify_deferred`; Apple discoveries and reconciliation evidence are preserved.
- Live guarded export completed with 934 managed tracks, zero duplicates, and one unrelated user-added
  track preserved. The final automatic rerun added zero tracks, proving idempotency.
- Spotify cooldown: none active. Historical cooldown expiration remains preserved.
- The preserved campaign has 282 playlist-eligible desired tracks after reconciliation; all 282 are
  represented in the export ledger. The original 265 count grew as priority work confirmed more
  records.
- Bounded live Apple-priority bootstrap processed 80 of 134 carried artists using the available
  Artist Albums allowance. It produced no 429 or cooldown and consumed no broad artist or request
  capacity.
- Apple-priority queue: 54 remaining. Broad Spotify work correctly remains blocked behind this queue.
- Spotify Artist Albums usage: 80 of 80 trailing-24-hour calls, all priority work. Next capacity is
  expected after `2026-08-09T22:57:05.633Z`; no active lease or stale lock remains.
- Current endpoint telemetry: 80 artist-albums, 16 album-detail, 0 album-tracks, 130 playlist reads,
  16 playlist writes, and 23 OAuth/other requests in the trailing 24 hours. Broad daily usage is zero.
- Next scheduled full Apple job: Thursday, August 13 at 9:00 PM PDT. Next Friday catch-up: August 14
  at 9:00 AM PDT.

## Validation

- Passed: formatting, lint, strict TypeScript across 6 workspaces, and the 27-route production build.
- Passed: 445 unit tests across 60 files, 134 PostgreSQL integration tests across 25 files, and 30
  Playwright tests.
- Passed: migration application, local browser smoke, empty console-error inspection, and
  `git diff --check` before the final documentation refresh.
- Doctor: READY with PostgreSQL available, 28 migrations, no active cooldown, no stale locks, no
  album-completeness discrepancy, and both required Spotify playlist scopes.

## Risks And Blockers

- Spotify quota limits remain unpublished. Local endpoint and rolling ceilings reduce risk but cannot
  guarantee the absence of future 429 responses.
- A complete recurring Thursday-Friday-Saturday week has not yet run unattended.
- The current 54-item Apple-priority queue must drain before the next automatic playlist checkpoint
  and before broad Spotify reconciliation.
- Windows Task Scheduler must invoke the unified tick with the ignored local production capability
  settings. PostgreSQL remains the schedule authority.

## Immediate Next Step

Resume unified ticks after Artist Albums capacity returns. Drain the remaining 54 Apple-priority
artists, run the guarded playlist checkpoint for any newly eligible tracks, then allow bounded broad
reconciliation and its batched automatic playlist checkpoint.

## Deferred

- Any Spotify pacing or quota increase
- Historical deep reconciliation beyond bounded daily rotation
- MusicBrainz production reactivation, Reddit activation, SoundCloud automation, and new providers
