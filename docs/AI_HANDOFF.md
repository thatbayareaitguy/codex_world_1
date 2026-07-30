# AI Handoff

Updated: 2026-07-29 17:13 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, personal
account data, authorization material, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Latest implementation commit: `2f41192` (`fix: resume expired Spotify campaigns safely`).
- The branch was synchronized with upstream at `0/0`, with a clean worktree, before this handoff
  update.
- Current milestone: the existing 292-artist Spotify campaign is continuing after its authoritative
  cooldown expired.

## Architecture And Database

- TypeScript pnpm monorepo with a Next.js web/API application, short-lived Node scanner,
  provider-neutral core, Drizzle/PostgreSQL repositories, validated provider adapters, and fixtures.
- PostgreSQL is authoritative for canonical music data, source evidence, request telemetry,
  cooldowns, leases, scheduler work, album retrieval checkpoints, and campaign state.
- Production has 17 applied forward migrations. The latest migration adds normalized, secret-safe
  Spotify 429 classifications.
- Every Spotify API and token request uses one PostgreSQL-backed request gate. Concurrency is one,
  request starts are at least 10 seconds apart, provider cooldowns are durable, and playlist writes
  remain disabled.
- Campaign execution is bounded to one work item per tick, at most six requests and 90 seconds.
  Base artists currently become eligible every 145.7 seconds, while release-detail and track work
  may consume additional requests between base-artist claims.

## Active Spotify Campaign

- Campaign: `a68a793c-477a-4918-aab1-876fe6b5316a`.
- Snapshot at 2026-07-29 17:13 PDT: the database row is `running`; 102 of 292 qualifying artist
  successes, 190 pending, zero active reservations, and no campaign lease.
- Progress: 34.9% complete by qualifying artists.
- Work: 109 release-detail items completed and no campaign-attributed detail or track backlog.
- Continuation telemetry: six Spotify requests, minimum request-start gap 10.016 seconds, zero HTTP
  429 responses, and no new cooldown.
- The latest base-artist request received HTTP 429 with confirmed `quota_exceeded`. Spotify supplied
  Retry-After `68432`; the durable cooldown remains active until 2026-07-29 10:04 PDT.
- The replacement task `TS New Music Radar Final Spotify Continuation` runs the campaign CLI
  headlessly through `conhost.exe --headless` and `node.exe --import tsx`. It repeats approximately
  once per minute, ignores overlapping invocations, wakes the computer where supported, and has a
  three-minute per-invocation limit.
- Campaign hard deadline passed at 2026-07-28 18:01 PDT. Cooldown handling prevented another work
  claim from processing the expired deadline, so the row remained stale `running`. The campaign was
  safely changed to `paused` through the existing control path without altering members or work.
- Same-campaign deadline extension and resume are implemented with baseline, success-count,
  reservation, lease, and work-preservation guards. The same campaign resumed with a new deadline
  of 2026-07-30 17:06 PDT after a successful custom-format PostgreSQL backup.

## Confirmed Capabilities

- **Verified:** canonical watchlist and feed, Spotify followed-artist import, bounded and resumable
  discovery, artwork, evidence, album-track completeness, scan history, cooldown handling,
  secret-safe 429 telemetry, MusicBrainz mapping/discovery, MockProvider, and policy controls.
- **Live verified:** exact bounded-campaign targeting, durable progress across restarts and sleep,
  single-request serialization, 10-second minimum request spacing, cooldown recovery, release
  persistence, album completeness, and idempotency.
- **Partially verified:** Spotify Development Mode capacity. Three historical 429 events exist
  across varied immediate request intervals. All occurred after at least 151 requests in the
  preceding 24 hours, but only one is confirmed as `quota_exceeded`; the provider limit remains
  unpublished and cannot be inferred from three events.
- **Blocked:** Reddit live access pending approval.
- **Deferred:** playlist writes, SoundCloud automation, additional providers, playback, and
  reconciliation execution.

## Verification

- Current credential-free checkpoint: format, lint, strict TypeScript across six projects,
  production build, 291 unit tests, 83 PostgreSQL integration tests, 23 Playwright tests, doctor,
  and diff checks passed.
- Doctor reports the local system `READY` apart from the required Spotify cooldown wait. PostgreSQL
  is available, 17 migrations are applied, playlist writes remain disabled, and no stale lock
  exists.

## Known Risks

- Spotify Development Mode limits are unpublished. A valid Retry-After remains authoritative.
- Fixed 145.7-second artist spacing does not cap total request volume because release follow-ups
  run between base artists.
- The campaign has 190 pending baseline artists and must finish or stop safely before its
  2026-07-30 17:06 PDT continuation deadline.
- Do not change pacing or campaign architecture while this validation campaign is active.

## Required Post-Campaign Architecture Review

Implement and validate adaptive, request-budgeted base-artist pacing:

- Count actual catalog, release-detail, track-page, and OAuth requests rather than treating one
  artist as one request.
- Pull the next base artist forward when follow-up work is empty and rolling request budgets allow.
- Delay the next base artist when the previous artist consumed multiple follow-up requests.
- Preserve the global 10-second minimum, one-request concurrency, rolling 30-minute and 24-hour
  boundaries, durable cooldowns, request leases, resumability, and playlist isolation.
- Use persisted request telemetry and a conservative configurable budget. Do not probe Spotify to
  discover a limit.
- Compare campaign throughput, requests per artist, 429 frequency, and idle time before replacing
  the fixed schedule.

## Immediate Next Step

Allow the headless continuation task to process only campaign
`a68a793c-477a-4918-aab1-876fe6b5316a`. Monitor qualifying successes, request pacing, cooldowns,
campaign-attributed work, and the 24-hour deadline. Stop and preserve progress on a provider
cooldown, integrity failure, or unexpected provider or playlist request. Conduct the adaptive-pacing
architecture review after this campaign.
