# AI Handoff

Updated: 2026-07-27 17:54 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, personal
account data, authorization material, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Current checkpoint: the pending Spotify 429 classification commit, based on
  `b8a04cd1814751b03c8396c72471e9a1d20a08b3`.
- Upstream matched the base checkpoint at `0/0`; the worktree contains only this milestone's
  implementation, migration, tests, and documentation.
- Current milestone: safe Spotify 429 classification is implemented and credential-free verified.
- Immediate next step: commit and push this implementation, then create the authorized final bounded
  campaign for all 292 remaining never-successfully-scanned artists.

## Architecture And Database

- TypeScript pnpm monorepo with a Next.js web/API application, short-lived Node scanner,
  provider-neutral core, Drizzle/PostgreSQL repositories, validated provider adapters, and fixtures.
- PostgreSQL is authoritative for canonical music data, source evidence, request telemetry,
  cooldowns, leases, scheduler work, album retrieval checkpoints, and campaign state.
- Production has 17 applied forward migrations. Migration `0016_spotify_429_classification` adds
  nullable normalized classification and safe reason-token fields plus one diagnostic index. The
  bounded campaign model stores deterministic
  baseline membership, exact-success reservations, deadlines, effective configuration, and work
  attribution.
- Campaign ticks reuse the global operation lock, PostgreSQL Spotify request gate, provider cooldown,
  scheduler work, release ingestion, and album-track checkpoints. Concurrency is one, request starts
  are at least 10 seconds apart, and each tick is bounded to six requests and 90 seconds.
- Campaign release work is isolated by campaign ID. Reconciliation and ordinary scheduler work are
  ineligible in campaign mode.
- Spotify 429 bodies are inspected only through a 4 KB parser at `error.reason`. Exact
  `QUOTA_EXCEEDED` becomes `quota_exceeded`; missing or unusable reasons become `unspecified_429`;
  bounded unknown tokens become `unknown_reason`; and pre-migration events remain
  `legacy_unknown`. Raw bodies and arbitrary error messages are not stored or logged. Retry-After,
  cooldown, pacing, and global-gate behavior are unchanged.

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
- Spotify request telemetry remains 876 events with latest start
  `2026-07-27T22:09:27.387Z`; credential-free implementation made zero provider requests or OAuth
  refreshes. Doctor reports two historical `legacy_unknown` 429 events, no newly classified event,
  and no active cooldown.
- Pre-live backup remains outside source control:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\backups\ts-new-music-radar-2026-07-27T15-38-01-673Z.dump`.

## Verification

- Focused Spotify and doctor unit verification: 49 of 49 tests passed.
- Focused PostgreSQL classification, migration, and scan-isolation verification: 27 of 27 tests
  passed.
- Live campaign database checks passed for exact targeting, request serialization, pacing,
  campaign isolation, album completeness, duplicates, Batch 3 preservation, and cleanup.
- Lint, strict TypeScript across six projects, production build, and 291 of 291 unit tests in 41
  files passed. PostgreSQL integration passed 80 of 80 tests in 14 files, including clean and
  upgrade migration paths. Playwright passed 23 of 23 tests. Final format and diff checks are
  pending only the completed documentation update.
- The prior mocked Reddit suite-order defect is corrected in test setup by selecting the exact
  canonical artist credit for its same-title Spotify-backed fixture; no runtime Reddit behavior
  changed.

## Capability Status

- **Verified:** canonical watchlist and feed, Spotify import and bounded discovery, artwork, source
  evidence, album-track resume/completeness, global Spotify request gate and cooldown, scan history,
  safe 429 parsing and aggregation, MusicBrainz mapping/discovery, MockProvider, and default-off
  policy controls.
- **Live verified:** restart-safe campaign execution, exact 100 boundaries across two campaigns,
  campaign work attribution and drain, cooldown recovery, 10-second pacing, and temporary headless
  Windows execution.
- **Partially verified:** Spotify Development Mode request tolerance. Two bounded cohorts completed,
  but unpublished limits remain variable and a prior campaign encountered one recoverable 429.
- **Blocked:** Reddit live access pending approval. SoundCloud remains manual outbound links only.
- **Implemented but not live-tested:** reason-bearing Spotify 429 classification. No live request was
  made to manufacture a provider response; the path is verified with injected responses and
  PostgreSQL integration tests.
- **Known defect:** none currently blocks the final bounded campaign.
- **Planned:** one authorized campaign snapshot containing all 292 remaining artists, followed by
  campaign-attributed release-detail and track-work drain and full initial-sync evaluation.
- **Deferred:** Batch 3, reconciliation execution, playlist writes, remaining provider integrations,
  playback, sleep-resume hardening, and a permanent production scheduler task.

## Risks And Decisions

- Spotify Development Mode limits are unpublished. The global gate and durable cooldown make a 429
  recoverable but cannot guarantee it will not recur.
- Spotify 429 classification is diagnostic only. A valid Retry-After remains authoritative
  regardless of classification.
- The final 292-artist bounded campaign is authorized by the current milestone; no additional user
  decision is required before its safety gates pass.
