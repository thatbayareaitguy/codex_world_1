# Implementation Plan

## Current: dormant MusicBrainz production boundary

MusicBrainz is preserved as an advanced adapter but defaults off. Normal scans, direct identity
commands, web APIs, review workflows, settings, source status, system status, and scan history omit
MusicBrainz unless `MUSICBRAINZ_ENABLED=true` is explicitly set for a separately validated session.
Historical mappings, evidence, scan telemetry, and schema remain intact. The next product milestone
is Apple-first Spotify reconciliation; deleting MusicBrainz code or data is explicitly deferred.

## Current: bounded initial Spotify synchronization

The rolling scheduler is implemented and bounded-live validated. Migration `0015` adds the minimal
durable campaign boundary needed to authorize an exact number of first-successful artist scans
across independent scheduler ticks.

1. Completed: deterministic baseline snapshot of active, confirmed, never-successfully-scanned
   artists, campaign lifecycle, deadline, status, and configuration snapshot.
2. Completed: transactional qualifying-slot reservation, exactly-once success conversion, expired
   reservation recovery, ten-success canary pause, and exact target guard.
3. Completed: campaign attribution for release-detail and release-track work, with unrelated detail
   and reconciliation work excluded from campaign execution.
4. Completed: plan/status/member/work and lifecycle CLI, doctor diagnostics, one-work campaign tick,
   and temporary non-overlapping Windows Task Scheduler scripts.
5. Verified credential-free: 280 unit tests, 78 PostgreSQL integration tests, clean and upgrade
   migrations, 593/101/492 scale simulation, concurrent race at 99, strict typecheck, lint, build,
   23 Playwright tests, and doctor.
6. Next authorized phase: commit and push the implementation, then create one live campaign with
   target 100, canary 10, and an eight-hour deadline. Automatically continue only after the canary
   integrity checks pass.

Batch 3, playlist operations, reconciliation, and the remaining initial watchlist stay untouched.

## Completed milestones (archived)

The sections below preserve the implementation history. Docker, PostgreSQL, migrations through `0013`, release appearances, album-track checkpoints, Spotify and MusicBrainz request gates, local operations, and the staged Spotify validations are complete at the current checkpoint.

## Spotify and MusicBrainz milestone

## Pre-sync data integrity and release completeness

- Normalize release membership through provenance-backed `release_track_appearances`; retain `tracks.release_id` only as a deprecated compatibility pointer.
- Repair proven historical Spotify associations without changing canonical recording IDs, feed preferences, evidence, artwork, or manual decisions. Leave unprovable relationships unresolved.
- Persist every Spotify release-track page and unique provider track ID before requesting the next page. Resume from the stored offset after restart, rate limit, request-budget pause, or failure.
- Mark a release complete only after a terminal page, exact unique-count agreement with `total_tracks`, and no unresolved page error. Surface partial and discrepancy states in the feed and doctor diagnostics.
- Block persisted artist work when its expected Spotify mapping is missing or changed. Retry only after that exact mapping is restored.
- Treat `Keep separate` as creation or preservation of a distinct recording and feed discovery, never as candidate rejection.
- Complete credential-free unit, PostgreSQL upgrade/clean-migration, and Playwright verification. Do not make live provider or playlist requests and do not begin the watchlist sync.

## Resumable Spotify Completeness

- Keep daily discovery at one page for fast recent-release checks, while preserving a deeper cursor and a partial status whenever more catalog pages remain.
- Resume initial and periodic reconciliation from the stored offset in bounded two-page work units.
- Persist page telemetry and provider catalog summaries after each page without creating canonical records for old out-of-window releases.
- Limit each run to 150 Spotify requests and pause cleanly with the current cursor retained.
- Revisit fully reconciled artists only after a 30-day cycle expires or an explicit new cycle is requested.
- Expose per-artist and provider-level coverage without claiming exact completion time or guaranteed completeness.
- Validate only the approved six-artist dry-run sample. Do not start distributed reconciliation or the full watchlist scan.
- Current live result: 20 page requests in the corrected sample, 31 total milestone requests, a 5.007-second minimum interval, no 429, no later-page backfill release, and no canonical writes.

## MusicBrainz hardening checkpoint

- Add a database-backed global one-request-per-second MusicBrainz gate and safe endpoint telemetry.
- Browse release groups, primary releases, and track-artist appearances as distinct stages.
- Persist after every stage and record resumable per-artist batch progress.
- Add mapping preview, confidence, evidence, confirmation, rejection, and replacement controls.
- Keep MusicBrainz-only scans independent from Spotify cooldown and playlist synchronization.
- Validate YUSSI first, rerun for idempotency, then validate at most 10 confirmed artists.
- Do not begin a 50-artist validation without explicit approval, and never start all 593 artists here.
  Verified: 2026-07-17

## Spotify Development Mode Hardening

The current work adds one database-backed Spotify request gate, safe 429 telemetry, a persistent client-wide cooldown, configurable one-at-a-time pacing, bounded artist-album pagination, known-release skipping, and resumable 15-artist batches. Initial, daily, and deep-reconciliation modes have separate page limits. The first staged batch requires confirmation. Live validation remains blocked until the preserved cooldown expires and must proceed with YUSSI, then 5 artists, then 15 artists. No full-watchlist scan is part of this work.

## Preserved Work

Keep the pnpm monorepo, strict TypeScript, Drizzle schema and migration history, canonical watchlist, deterministic matching engine, source evidence, feed states, scanner, MockProvider, manual SoundCloud link records, repaired controls, theme selector, and existing tests.

## Implementation Order

1. Add Docker Compose commands for distinct local and test PostgreSQL databases. Integration tests provision, migrate, and reset the test database or fail with an actionable Docker error. They never skip.
2. Add validated server-only configuration for Spotify, MusicBrainz, the initial backfill window, encryption, and the default-disabled manual SoundCloud feature.
3. Extend the schema with OAuth lifecycle metadata, single-use OAuth state, artist aliases and mapping provenance, provider field evidence, scan locks and metrics, upcoming-date history, and playlist synchronization metadata. Add only forward migrations.
4. Implement authenticated server-side Spotify Authorization Code flow with PKCE, short-lived signed HTTP-only state cookies, encrypted refresh tokens, automatic rotation, redacted structured errors, disconnect, and personal-data deletion.
5. Implement a runtime-validated Spotify client using only current endpoints. Complete cursor and offset pagination, bounded concurrency, timeouts, cancellation, `Retry-After`, token refresh, and structured errors.
6. Add a user-approved followed-artist preview and batched confirmation workflow. Preserve manual canonical names, deduplicate reruns, and route ambiguous names to review.
7. Implement a read-only MusicBrainz client with a contactable User-Agent, one global request per second, bounded 503 retries, artist scoring, release-group and release browse, and `track_artist` appearance browse.
8. Extend scanner arguments and orchestration for enabled providers, artist filters, dry runs, full scans, since dates, backfill windows, provider isolation, scan locking, checkpoints, and idempotent persistence.
9. Extend matching regression coverage and persist algorithm version, reasons, conflicting source values, provider identifiers, release-level relationships, upcoming date history, and review records.
10. Complete the feed, provider settings, watchlist mappings, review queue, scan history, private Spotify playlist preview and synchronization, privacy, terms, disconnect, and deletion controls. Hide manual SoundCloud controls by default.
11. Add synthetic unit, database integration, and Playwright tests. Normal verification never calls Spotify or MusicBrainz.
12. Update all repository documentation, run every required command, inspect the complete diff, and correct migration, interaction, security, and stale-documentation defects.

## Verified Provider Constraints

- Spotify Development Mode requires the app owner to retain Premium. Initial authorization requests only `user-follow-read` and `playlist-read-private`. The add-only export requests both `playlist-modify-private` and `playlist-modify-public` only when the default-off write gate and one allowed private target are explicitly enabled. The broader OAuth scope does not alter the server-side single-playlist, ownership, private, non-collaborative, and add-only restrictions.
- Use `GET /me` and stable `account_id`, `GET /me/following`, individual artist, album, and track endpoints, and configured playlist `/items` endpoints. Do not list or create playlists for export selection.
- Do not use removed browse new releases, user playlist routes, bulk track or artist reads, or playlist `/tracks` routes.
- Spotify followed artists use cursor pagination up to 50 per page. Artist albums and search use no more than 10 per page. Playlist item reads use up to 50 and additions use batches up to 100.
- MusicBrainz uses JSON search, release-group browse by confirmed artist MBID, release browse by artist, and release browse by `track_artist` for appearances. Browse pages are at most 100 and release offsets advance by actual result count.
- MusicBrainz requests are serialized at one request per second or slower and use `ReleaseInbox/<version> (<contact>)`.

## Policy Boundary

No playback, previews, embeds, audio handling, cross-provider artwork, Spotify-to-MusicBrainz payload transfer, live response fixtures, AI ingestion, public signup, or commercial behavior is implemented. MusicBrainz starts only from canonical user-approved watchlist data and confirmed mappings. Spotify policy compatibility remains unresolved and is not represented as approved.

---

## Reddit evidence milestone

Verified: 2026-07-16

## Approval And Policy Gate

Reddit's current Responsible Builder Policy requires explicit approval before any Data API access. Eligible free access is documented at 100 queries per minute per OAuth client ID averaged across ten minutes, but Reddit offers both free and paid access and decides eligibility during review. This repository therefore defaults `REDDIT_ENABLED` and `REDDIT_ACCESS_APPROVED` to `false`. The approval flag records only the owner's assertion after receiving actual approval and is not proof of Reddit approval.

No live request may occur unless both flags are true, credentials are configured, and the descriptive User-Agent is valid. Normal tests use synthetic content and injected HTTP handlers. No unauthenticated, RSS, scraping, browser-automation, search-cache, or third-party fallback is permitted.

## Implementation Order

1. Add typed Reddit configuration, approval-gate diagnostics, and server-only application-token caching using the approved `client_credentials` flow. Do not add a Reddit user connection.
2. Add a global 30-QPM limiter, response-header tracking, request and scan timeouts, bounded transient retries, exact `Retry-After` handling, and structured redacted metrics.
3. Add forward-only Reddit schema and migrations for configurable subreddit sources, submissions, parse results, extracted links, candidate relationships, cursor state, reconciliation history, and provenance-preserving review decisions. Seed `EDM` and `dubstep` while leaving the provider disabled.
4. Implement versioned local parsers for individual titles, safe bounded Markdown roundup lines, explicit and ambiguous dates, release classifications, artist credits, labels, version markers, and safe outbound links. Runtime code must not send Reddit content to any AI service.
5. Match parsed credits against canonical watchlist names, confirmed aliases, and confirmed Spotify or MusicBrainz mappings. Short, common, fuzzy, conflicting, and Reddit-only candidates require review.
6. Implement authenticated reads only for `/r/{subreddit}/new`, `/r/{subreddit}/search`, and `/api/info` on the OAuth API host. Listing pages request at most 100 items and use `after` cursors, overlap windows, lookback horizons, source locks, and idempotent writes.
7. Verify direct Spotify track and album links through the existing Spotify client. Retain SoundCloud and other safe links as unverified source evidence without fetching them. Reddit alone never makes a Spotify playlist item eligible.
8. Reconcile retained submission fullnames daily and purge deleted Reddit text, links, parse data, evidence, and Reddit-only candidates within the documented process. Independently corroborated canonical records survive without the Reddit association.
9. Add database-backed routes and settings controls for source CRUD, pause or resume, scans, backfills, cursor reset, search previews, reconciliation, review decisions, and aggregate Reddit-data deletion. Closed-gate controls remain visibly disabled with an explanation.
10. Extend feed and review views with Reddit provenance, confidence, corroboration, subreddit filters, upcoming labels, and deletion state without author identity, HTML, embeds, media, comments, votes, or karma.
11. Add synthetic unit, integration, and Playwright coverage for the approval gate, client, parser, matching, persistence, deletion, source management, feed, and review workflows. Add a separately invoked dry-run live smoke command that refuses to run without approved configuration.
12. Update privacy, terms, provider capability, architecture, security, registration, deployment, parser, and deletion documentation. Run formatting, lint, type checking, unit tests, clean migrations, integration tests, build, Playwright, and diff checks before handoff.

## Unresolved External Decisions

- Reddit has not approved this application.
- Official documentation does not guarantee that this specific use case will receive free access.
- The archived OAuth technical guide documents application-only `client_credentials`, but the exact approved application type and authentication method must match Reddit's approval response.
- If Reddit requires payment, another authentication flow, Devvit hosting, or terms incompatible with this private application, the provider remains disabled and no fallback is used.

---

## Integration hardening and local readiness milestone

Verified: 2026-07-16

## Repository Findings

- The committed baseline contains Spotify, MusicBrainz, MockProvider, canonical matching, scanning, feed, review, playlist synchronization, and database migrations through `0004`.
- Reddit was not complete in the committed baseline. The working tree contains an approval-gated client and deterministic parser, but no Reddit persistence, migration, scanner orchestration, source-management UI, deletion reconciliation, or database and browser coverage.
- The repository has no doctor, backup, restore, application lifecycle, scan status, stale-lock recovery, full reconciliation, or optional live Spotify smoke commands.
- Docker-backed integration tests correctly fail when Docker is unavailable rather than reporting a skip. This machine's Docker availability must be rechecked during verification.
- The UI has provider and scan-history summaries but no consolidated operational status page or external scheduler status.
- Existing documentation describes the completed Spotify and MusicBrainz milestone accurately in broad terms, but does not yet document daily operation, backup recovery, diagnostics, or the incomplete Reddit implementation.

## Stabilization Order

1. Restore a clean dependency baseline from the lockfile and fix all current formatting, lint, type, and unit failures before extending operational behavior.
2. Finish the existing Reddit milestone boundary: forward migration, source records, disabled-by-default status, synthetic scan persistence, deletion purge, and source-management status. Do not enable live access or add another provider.
3. Add a secret-safe `pnpm doctor` command with tested readiness states for runtime versions, environment, database, migrations, providers, scan history, backup state, data directories, and local port availability.
4. Harden scanner coordination with one global normal-scan lock, provider result isolation, stale-lock inspection and recovery, status and reconciliation commands, trigger metadata, bounded error storage, and detailed-log retention configuration.
5. Add Windows-compatible `app:up` and `app:down` helpers that verify Docker, start PostgreSQL, apply migrations, and start the loopback-only application without modifying environment files.
6. Add PostgreSQL custom-format backup and guarded restore commands, out-of-tree default storage, metadata for last backup, restore confirmation, compatibility checks, and test-database recovery coverage.
7. Keep the optional, separately invoked Spotify live smoke command strictly read-only. Never run it during standard verification and expose no live playlist-write option.
8. Add a consolidated system-status API and UI with accurate database, provider, scanner, backup, and external-scheduler state. Every unavailable action must be disabled with a reason.
9. Add one database-backed synthetic workflow covering manual and imported artists, provider mappings, duplicate matching, review, feed, idempotent scans, playlist planning, disconnect, and canonical-data retention.
10. Rewrite the README as an operational guide and add daily-use, troubleshooting, manual-QA, scheduling, backup, security, and Reddit readiness documentation that matches implemented behavior.
11. Run empty-schema and upgrade migrations, all standard automated suites, backup and restore verification, repeated scans and playlist synchronization, stale-lock recovery, production build, browser tests, diagnostics, and diff inspection.

## Completion Boundary

This historical stabilization milestone did not add playback, public users, cloud infrastructure, commercial behavior, analytics, SoundCloud API access, YouTube, or TIDAL. Apple Music public-catalog discovery was implemented later under a separately approved milestone and paid-program exception. Reddit remains disabled until the owner has actual approved access and configures it explicitly. Live provider calls are never part of standard tests.
