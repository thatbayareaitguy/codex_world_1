# AI Handoff

Updated: 2026-07-22 19:40 PDT (UTC-07:00)

This is the canonical current implementation and operational snapshot. It contains no credentials
or raw provider data.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Implementation checkpoint: the commit containing this handoff, with parent
  `8262f27defaa9959bee70df6716a4927688919f0`.
- Worktree and upstream: expected clean and synchronized after the amended checkpoint is pushed.
- Current milestone: bounded Spotify sync campaign is implemented and credential-free verified.
  The next internal phase is the explicitly authorized live campaign for exactly 100 first-successful
  artist scans, with an automatic integrity gate at 10.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, short-lived Node scanner, provider-neutral core,
  Drizzle/PostgreSQL repositories, runtime-validated provider adapters, and test fixtures.
- PostgreSQL is authoritative for canonical music data, provider evidence, request telemetry,
  cooldowns, leases, scheduler work, album retrieval checkpoints, and bounded campaign state.
- Migration `0015_bounded_spotify_campaign.sql` adds campaign records, deterministic baseline
  membership, exact-success reservations, canary state, deadline and lease state, configuration
  snapshots, and campaign attribution on scheduler work. Production has 16 applied migrations.
- A campaign snapshots active, confirmed Spotify-mapped artists without successful coverage. A
  row-locked claim reserves one target slot atomically. Completion converts that reservation once,
  so concurrent claims cannot pass artist 100. The same guard pauses base claims at artist 10 until
  the canary transition is explicitly passed.
- Campaign ticks reuse the existing global operation lock, PostgreSQL Spotify request gate,
  persistent cooldown, scheduler work, release ingestion, and album-track checkpoints. One tick
  handles one work item, at most six requests, at most 90 seconds, and never less than 10 seconds
  between Spotify request starts.
- Campaign-created release detail and track work is durably attributed and can drain after the base
  target. Unrelated scheduler and reconciliation work remains untouched.

## Operational State

- Doctor: `READY`; PostgreSQL and the loopback application are available.
- Watchlist: 593 active confirmed Spotify mappings; 101 successful; 492 never successfully scanned.
- Spotify request telemetry: 501 events; latest start `2026-07-23T01:16:41.451Z`. This did not change
  during implementation or testing.
- Spotify: no active cooldown, provider lease, scheduler lease, operation lock, scan lock, or active
  campaign. Scheduler database mode and automatic capability remain disabled.
- Scheduler queue: 692 queued, 0 blocked, and no active work lease. Album integrity is 94 complete,
  0 partial, 0 missing tracks, and 0 discrepancies.
- Batch 3 remains untouched: 15 pending artists and zero batch-attributed requests.
- Playlist writes remain disabled and no allowed playlist is configured. No playlist request ran.
- Pre-migration backup is outside the repository at
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-07-23T01-54-55-613Z.dump`.

## Verification

- Format and lint passed with zero warnings.
- Strict TypeScript passed across all six configured projects.
- Unit: 280 tests in 41 files passed.
- PostgreSQL integration: 78 tests in 14 files passed, including clean migration, upgrade migration,
  cooldown, restart, lease recovery, campaign attribution, canary, exact-target, and concurrency.
- Scale-shaped simulation: 593 mapped artists, 101 prior successes, 492-member baseline, canary at
  exactly 10, one winner in a concurrent race at 99, exactly 100 successes, zero 101st claim, and
  drained campaign backlog.
- Production Next.js build passed. Playwright: 23 tests passed. `git diff --check` passed.
- No live provider request was made during implementation or verification.

## Capability Status

- **Verified:** canonical watchlist and feed, Spotify import and bounded discovery, artwork,
  evidence, album-track resume/completeness, global Spotify request gate and cooldown, scan history,
  MusicBrainz mapping/discovery, MockProvider, and default-off policy controls.
- **Implemented and credential-free verified:** durable bounded campaigns, exact target and canary
  guards, campaign work attribution, plan/status/member/work CLI, pause/resume/cancel, and temporary
  non-overlapping Windows task scripts.
- **Not live verified:** the bounded campaign runner, automatic canary continuation, exact live 100
  boundary, campaign backlog drain, and temporary Windows task recovery.
- **Blocked:** Reddit live access pending approval. SoundCloud remains manual outbound links only.
- **Deferred:** playlist writes, Batch 3, remaining initial sync, reconciliation cadence, and all
  excluded providers and playback.

## Risks And Next Action

- Spotify Development Mode limits remain unpublished. Ten-second pacing and durable cooldowns
  reduce risk but cannot guarantee the absence of HTTP 429 responses.
- A temporary Windows task depends on the local machine remaining available; database state remains
  authoritative through sleep, process exit, and restart.
- Next action after committing and pushing this implementation: re-run live preflight, create an
  out-of-tree backup, create one 100-target/10-canary/eight-hour campaign, validate plan mode, then
  register the temporary task and monitor the automatic canary.
- Decision needed from the user after this milestone: review the exact first-100 result before
  authorizing the remaining initial synchronization.
