# AI Handoff

Updated: 2026-08-07 17:20 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Latest commit: this commit, `feat: bootstrap recurring Apple-first discovery schedule`; parent
  `49e6664792270ac9e80e30caa8cca0318adbe851`
- Upstream: local and origin match after this commit is pushed normally
- Worktree: clean except unrelated untracked `outputs/`
- Milestone: first-week Apple bootstrap and recurring Spotify discovery schedule transition
- PostgreSQL: healthy; 25 forward migrations applied

## Current Operational State

- Campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94` is durably finalized as
  `completed_with_spotify_deferred`.
- Apple is complete for 583 of 583 artists. Those discoveries are the initial weekly Apple scan and
  were not rerun, discarded, or superseded.
- Spotify completed or partially processed 95 artists. The other 488 remain unfinished and were not
  marked complete.
- The transition queued 134 Apple-priority artists and retained 488 unfinished artists in the broad
  rolling backlog.
- The campaign has exactly 265 unique playlist-eligible Spotify tracks after exact campaign-evidence
  filtering. The playlist inbox is ready but has not run.
- Spotify cooldown remains stored until `2026-08-08T18:32:23.020Z`, or August 8 at 11:32:23 AM PDT.
  No Spotify request was made during this milestone.
- The next full Apple scan is stored for Thursday, August 13, 2026 at 9:00 PM PDT
  (`2026-08-14T04:00:00.000Z`).

## Implemented And Verified

- Database-only campaign transition is idempotent and preserves every Apple result and existing
  reconciliation record.
- Scheduler phases enforce cooldown, playlist inbox, Apple-priority work, broad Spotify work, then
  weekly Apple work.
- Apple-priority and broad work are persisted separately. Broad work cannot consume capacity until
  the campaign priority queue is drained.
- Campaign-scoped playlist planning selects only exact eligible Spotify track IDs, inserts at
  position zero in newest-first release order, keeps album tracks together, and remains add-only.
- Playlist export and scheduler activation both fail closed during a provider cooldown.
- Scheduler activation also requires a completed playlist inbox and never makes a provider request.

## Implemented But Not Live-Verified

- The 265-track campaign inbox export is waiting for the Spotify cooldown to expire.
- Apple-priority processing and broad rolling reconciliation are waiting for the inbox export and
  scheduler activation.
- Automatic weekly Apple execution is not enabled. Only the next required Thursday timestamp and
  phase boundary are persisted.

## Validation

- Formatting and lint passed.
- Strict TypeScript passed in 6 workspaces.
- Unit tests: 411 passed across 59 files.
- PostgreSQL integration tests: 113 passed across 23 files.
- All 25 migrations were applied to the development database.
- Production build passed with 27 routes, and 29 Playwright tests passed.
- Doctor reports the database, migrations, locks, album completeness, app, and configuration ready;
  the expected Spotify cooldown remains action-required.
- `git diff --check` passed.

## Risks And Policy Boundaries

- Spotify quota behavior is unpublished. Never probe, clear, or bypass the stored cooldown.
- Playlist operations remain limited to the configured owned private playlist and add-only exact or
  manually confirmed tracks. No other playlist operation is available.
- Apple and Spotify evidence remain provider-namespaced. No cross-provider request construction was
  added.
- Scheduler production capability remains disabled by default and must be enabled only after the
  inbox export completes.

## Next Action

After August 8, 2026 at 11:32:23 AM PDT:

1. Run `pnpm run doctor` and stop if a cooldown or lock remains.
2. Run `pnpm spotify:playlist-export -- --live --campaign 5f462e9e-c3db-451c-b77c-378ab21e8a94 --discovery-inbox`.
3. Verify readback, ordering, deduplication, and preservation of user-added tracks.
4. Run `pnpm discovery:bootstrap activate --campaign 5f462e9e-c3db-451c-b77c-378ab21e8a94`.
5. Drain Apple-priority Spotify work and export newly playable matches before allowing broad work.

## Deferred

- Broad Saturday target enforcement while Apple-priority work remains
- The remaining full watchlist scan
- Automatic Thursday Apple task registration
- MusicBrainz production reactivation, Reddit activation, SoundCloud automation, and new providers
