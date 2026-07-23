# AI Handoff

Updated: 2026-07-23 01:08 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It contains no credentials, account
data, or raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Current checkpoint: the commit containing this handoff, based on implementation commit
  `caa0f58025b4f11d4d34c137c78a8b320be626a7`.
- Worktree and upstream: clean and synchronized before this documentation update; expected clean and
  synchronized after its commit is pushed.
- Current milestone: the durable bounded Spotify campaign is implemented, credential-free verified,
  and live verified through exactly 100 first-successful artist scans.
- Immediate next step: review the first-100 result, then explicitly authorize a separate bounded
  campaign for the remaining initial synchronization.

## Architecture And Database

- TypeScript pnpm monorepo with a Next.js web/API application, short-lived Node scanner,
  provider-neutral core, Drizzle/PostgreSQL repositories, validated provider adapters, and fixtures.
- PostgreSQL is authoritative for canonical music data, source evidence, request telemetry,
  cooldowns, leases, scheduler work, album retrieval checkpoints, and campaign state.
- Production has 16 applied forward migrations. `0015_bounded_spotify_campaign.sql` adds campaign
  records, deterministic baseline membership, exact-success reservations, canary state, deadline and
  lease state, configuration snapshots, and campaign attribution on scheduler work.
- Campaign claims reserve a qualifying slot transactionally. Successful coverage converts it once,
  preventing artist 101. The same guard paused at artist 10 until the canary passed.
- Campaign ticks reuse the global operation lock, PostgreSQL Spotify request gate, provider cooldown,
  scheduler work, release ingestion, and album-track checkpoints. Concurrency is one, the request
  interval is at least 10 seconds, and each tick is bounded to six requests and 90 seconds.
- Campaign release work is isolated by campaign ID. Unrelated release and reconciliation work is not
  eligible in campaign mode.

## Live Campaign Result

- Campaign: `3fb11218-0210-45c8-972e-471bfdcb6a0d`; baseline 492; target 100; canary 10.
- Started `2026-07-23T02:48:59.624Z`, passed canary at `2026-07-23T03:19:22.017Z`, and completed
  `2026-07-23T07:56:13.730Z`, before the `2026-07-23T10:46:28.039Z` deadline.
- Final state: `completed`; 100 qualifying successes; 392 pending baseline members; zero blocked,
  skipped, reserved, or active members; zero open campaign work; zero artist 101.
- Coverage: 593 active confirmed Spotify mappings; successful 101 -> 201; never scanned 492 -> 392.
- Requests: 184 total, comprising 101 artist-albums, 77 album, and 6 OAuth token requests. Minimum
  request-start interval was 10.008 seconds; maximum was 240.308 seconds; no requests overlapped.
- Pacing: approximately 19.529 qualifying artists per hour; maximum rolling 30-minute volume was 24
  requests; maximum requests observed in one tick was 2; maximum work duration was 16.982 seconds.
- Rate limiting: one artist-albums request returned HTTP 429 with raw `Retry-After: 123`. The
  123-second cooldown was persisted and honored from `2026-07-23T06:41:13.414Z` through
  `2026-07-23T06:43:16.587Z`; one member then completed on its second attempt.
- Created during the campaign: 77 releases, 120 tracks, 140 appearances, 140 appearance sources,
  140 candidates, 140 evidence rows, 140 feed rows, and 77 artwork-bearing Spotify release rows.
- Final canonical totals: 171 releases, 307 tracks, 345 appearances, 345 appearance sources,
  345 candidates, 345 evidence rows, 345 feed rows, and 171 artwork-bearing Spotify release rows.
- Album integrity: 171 complete retrievals; zero partial, missing-cursor, track-count discrepancy,
  invalid-complete, or unresolved-error records.
- Duplicate groups: zero provider IDs, appearances, appearance sources, candidates, evidence
  identities, feed keys, campaign memberships, ordinals, and scheduler work keys.

## Operational State

- Doctor: `READY`; PostgreSQL and the loopback application are available.
- Spotify: no active cooldown, provider lease, scheduler lease, operation lock, scan lock, campaign
  lease, member lease, reservation, or active campaign.
- Scheduler database mode and ordinary automatic capability are disabled. The temporary Windows task
  was changed to a headless `conhost.exe` plus `node.exe --import tsx` launcher to prevent console
  focus changes, then disabled and deleted after completion.
- Scheduler queue: 692 queued, zero blocked, and no active lease. Reconciliation remains 99 queued
  and was not executed by the campaign.
- Batch 3 remains untouched: 15 pending artists and zero batch-attributed requests.
- Playlist writes remain disabled. The campaign made zero playlist, MusicBrainz, Reddit,
  SoundCloud, ListenBrainz, or other-provider requests.
- Backups remain outside the repository:
  - Pre-migration:
    `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-07-23T01-54-55-613Z.dump`
  - Pre-live:
    `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-07-23T02-45-42-423Z.dump`

## Verification

- Format passed. Lint passed with zero warnings. Strict TypeScript passed across six projects.
- Unit: 280 of 280 tests in 41 files passed.
- PostgreSQL integration: 78 of 78 tests in 14 files passed, including clean and upgrade migration,
  cooldown, restart, lease recovery, campaign attribution, canary, exact-target, and concurrency.
- Credential-free scale simulation: 593 mapped artists, 101 prior successes, 492-member baseline,
  canary at exactly 10, one winner at the concurrent 99 boundary, exactly 100 successes, no 101st
  claim, and a drained campaign backlog.
- Production Next.js build passed. Playwright: 23 of 23 tests passed. `git diff --check` passed.
- Live canary and full bounded campaign passed all integrity, pacing, isolation, and cleanup checks.

## Capability Status

- **Verified:** canonical watchlist and feed, Spotify import and bounded discovery, artwork, evidence,
  album-track resume/completeness, global Spotify request gate and cooldown, scan history,
  MusicBrainz mapping/discovery, MockProvider, and default-off policy controls.
- **Live verified:** campaign creation and restart-safe execution, canary transition, exact 100
  boundary, campaign work attribution and drain, cooldown recovery, and temporary Windows execution.
- **Partially verified:** Spotify Development Mode request tolerance. This run completed safely but
  the provider returned one 429, and its unpublished limits remain variable.
- **Blocked:** Reddit live access pending approval. SoundCloud remains manual outbound links only.
- **Planned:** a separately authorized bounded campaign for the remaining 392 never-scanned artists.
- **Deferred:** Batch 3, artist reconciliation execution, playlist writes, remaining provider
  integrations, playback, and a permanent production scheduler task.

## Risks And Decisions

- Spotify Development Mode limits are unpublished. The global gate and durable cooldown make a 429
  recoverable but cannot guarantee it will not recur.
- The 100-artist campaign does not authorize the remaining 392 baseline artists.
- User decision required: select the next bounded cohort size and authorize the remaining initial
  synchronization. Do not start it implicitly.
