# AI Handoff

Updated: 2026-07-27 15:15 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, personal
account data, authorization material, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Current checkpoint: the commit containing this handoff, based on
  `3e0a8e45010f8e3665b8b6312f36ebc9cc2c7244`.
- Worktree and upstream were clean and synchronized before this documentation update.
- Current milestone: the second durable bounded Spotify campaign completed exactly 100 additional
  first-successful artist scans.
- Immediate next step: review this second 100-artist cohort, then explicitly authorize another
  bounded cohort from the remaining 292 never-successfully-scanned artists.

## Architecture And Database

- TypeScript pnpm monorepo with a Next.js web/API application, short-lived Node scanner,
  provider-neutral core, Drizzle/PostgreSQL repositories, validated provider adapters, and fixtures.
- PostgreSQL is authoritative for canonical music data, source evidence, request telemetry,
  cooldowns, leases, scheduler work, album retrieval checkpoints, and campaign state.
- Production has 16 applied forward migrations. The bounded campaign model stores deterministic
  baseline membership, exact-success reservations, deadlines, effective configuration, and work
  attribution.
- Campaign ticks reuse the global operation lock, PostgreSQL Spotify request gate, provider cooldown,
  scheduler work, release ingestion, and album-track checkpoints. Concurrency is one, request starts
  are at least 10 seconds apart, and each tick is bounded to six requests and 90 seconds.
- Campaign release work is isolated by campaign ID. Reconciliation and ordinary scheduler work are
  ineligible in campaign mode.

## Second Campaign Result

- Campaign: `70d602ee-4469-4cd5-ace2-f0eae8163b5a`; baseline 392; target 100; canary target 100.
- Started `2026-07-27T15:40:08.384Z` and completed `2026-07-27T22:09:27.723Z` in 6:29:19, before
  the `2026-07-27T23:39:16.321Z` deadline.
- Final state: `completed`; 100 qualifying successes; 292 pending baseline members; zero active
  reservations, leases, or open campaign work; no 101st artist.
- Coverage: 593 active confirmed Spotify mappings; successful 201 -> 301; never successful 392 -> 292.
- Requests: 191 total, comprising 100 artist-albums, 84 album, and 7 OAuth token requests. Minimum
  request-start interval was 10.010 seconds; no requests overlapped.
- Pacing: about 15.4 qualifying artists per hour; maximum rolling 30-minute volume was 24 requests;
  maximum requests attributed to one work item was 2.
- Rate limiting: zero HTTP 429 responses and no new cooldown.
- Artist outcomes: 97 partial page-one catalog scans, 3 complete page-one scans, and 45 scans with no
  backfill-eligible release. All 100 selected artists persisted a terminal successful coverage state.
- Created during the campaign: 84 releases, 128 tracks, 131 appearances, 131 appearance sources,
  132 candidates, 132 evidence rows, 132 feed rows, and 84 artwork-bearing Spotify release rows.
- Final canonical totals: 255 releases, 435 tracks, 476 appearances, 476 appearance sources,
  477 candidates, 477 evidence rows, 477 feed rows, and 255 artwork-bearing Spotify release rows.
- Album integrity: 255 complete retrievals; zero partial, missing-cursor, track-count discrepancy,
  invalid-count, stored-discrepancy, or item-count mismatch records.
- Duplicate groups: zero provider IDs, availability IDs, catalog releases, retrievals, retrieval
  items, appearances, appearance sources, candidates, evidence identities, feed keys, campaign
  memberships, ordinals, and scheduler work keys.

## Operational State

- Doctor: `READY`; PostgreSQL and the loopback application are available.
- Spotify: no active cooldown, provider lease, scheduler lease, operation lock, scan lock, campaign
  lease, member lease, reservation, or active campaign.
- Scheduler database mode and ordinary automatic capability are disabled. The temporary headless
  Windows campaign task was deleted, and no campaign CLI process remains.
- Scheduler queue: 692 queued, zero blocked, and no active lease. Reconciliation remains queued and
  was not executed by this campaign.
- Batch 3 remains untouched: 15 pending artists and zero batch-attributed requests.
- Playlist writes remain disabled. The campaign made zero playlist or MusicBrainz requests.
- Pre-live backup remains outside source control:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-07-27T15-38-01-673Z.dump`.

## Verification

- Focused credential-free unit verification: 16 of 16 tests in 5 files passed.
- Focused PostgreSQL integration verification: 32 of 32 tests in 4 files passed.
- Live campaign database checks passed for exact targeting, request serialization, pacing,
  campaign isolation, album completeness, duplicates, Batch 3 preservation, and cleanup.
- Format, lint, strict TypeScript across six projects, production build, and 280 of 280 unit tests in
  41 files passed. Playwright passed 23 of 23 tests.
- The canonical PostgreSQL integration command reproducibly passed 77 of 78 tests. Its existing
  mocked Reddit evidence assertion failed only in the full suite; the affected file passed 15 of 15
  tests against a freshly prepared test database. This operations-only milestone did not change
  application or test source.

## Capability Status

- **Verified:** canonical watchlist and feed, Spotify import and bounded discovery, artwork, source
  evidence, album-track resume/completeness, global Spotify request gate and cooldown, scan history,
  MusicBrainz mapping/discovery, MockProvider, and default-off policy controls.
- **Live verified:** restart-safe campaign execution, exact 100 boundaries across two campaigns,
  campaign work attribution and drain, cooldown recovery, 10-second pacing, and temporary headless
  Windows execution.
- **Partially verified:** Spotify Development Mode request tolerance. Two bounded cohorts completed,
  but unpublished limits remain variable and a prior campaign encountered one recoverable 429.
- **Blocked:** Reddit live access pending approval. SoundCloud remains manual outbound links only.
- **Known defect:** the full PostgreSQL integration suite has shared-state or suite-order sensitivity
  in one mocked Reddit evidence assertion even though the same integration file passes in isolation.
- **Planned:** a separately authorized bounded campaign from the remaining 292 artists.
- **Deferred:** Batch 3, reconciliation execution, playlist writes, remaining provider integrations,
  playback, sleep-resume hardening, and a permanent production scheduler task.

## Risks And Decisions

- Spotify Development Mode limits are unpublished. The global gate and durable cooldown make a 429
  recoverable but cannot guarantee it will not recur.
- This campaign does not authorize another artist cohort.
- User decision required: choose and authorize the next bounded cohort size after reviewing this
  result.
