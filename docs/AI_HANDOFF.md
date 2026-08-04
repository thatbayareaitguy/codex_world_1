# AI Handoff

Updated: 2026-08-04 13:57 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Latest implementation commit: `e8ecbd237b3ed661953020f1f7239bf644584c28`,
  `feat: integrate Apple Music discovery`.
- HEAD matches `origin/codex/release-radar-hardening`. The worktree contains the verified Apple
  prerelease-placeholder and upcoming-state correction listed below; it is not committed.
- Current milestone: production Apple Music public-catalog discovery is complete. Prerelease
  semantics have been corrected and verified locally.
- Source-only Apple worktree `codex_world_1_apple` and the iTunes worktree remain unchanged.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, short-lived Node scanner, provider-neutral core,
  Drizzle/PostgreSQL repositories, runtime-validated providers, Vitest, and Playwright.
- PostgreSQL is authoritative for canonical identity, evidence, feed, reviews, scans, request gates,
  cooldowns, batches, and provider cursors.
- Production has 18 applied forward migrations. Migration `0017_confused_whistler.sql` adds Apple
  request state, response cache, scan batches, artist scans, artist state, request events, and
  candidate-free mapping reviews.
- A verified PostgreSQL custom-format backup was created before migration at
  `%LOCALAPPDATA%\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-04T18-50-33-713Z.dump`.
  `pg_restore --list` reported 397 archive entries from PostgreSQL 17.10.
- A second verified custom-format backup was created before the prerelease data correction at
  `%LOCALAPPDATA%\TSNewMusicRadar\backups\ts-new-music-radar-2026-08-04T20-50-12-848Z.dump`.
  `pg_restore --list` reported 429 archive entries from PostgreSQL 17.10.
- Spotify, Apple Music, and MusicBrainz use separate PostgreSQL-backed global request gates.
  Playlist writes remain disabled.

## Verified

- Apple normal command: `pnpm scan -- --provider apple_music`.
- Secure ES256 developer-token generation, strict catalog endpoint allowlist, bounded payloads,
  timeouts, retry and cooldown handling, response cache, and safe request telemetry.
- Identity bootstrap preserved 320 confirmed mappings. The review queue contains 1,341 pending
  candidate rows for 273 unresolved artists, including one candidate-free manual numeric-ID case.
- Candidate confirmation, replacement, sibling-review resolution, candidate-free validation,
  reload persistence, and accessible review controls are covered by database and Playwright tests.
- Shallow first-page `singles` and `full-albums` discovery uses a 30-day or last-success window and
  fetches tracks only for eligible releases. Optional missing views and invalid release records are
  isolated. A direct artist lookup distinguishes a valid empty catalog from an invalid mapping.
- Live canary: YUSSI completed twice without duplicates. Apple evidence and artwork attached to the
  existing canonical Spotify-backed `Hold On` feed appearance.
- Full live batch: 320 of 320 mapped artists completed, zero artist failures, 209 legitimate
  no-result artists, 829 real requests, 50 cache hits, minimum real request interval 1102 ms, zero
  429 responses, and no cooldown.
- Production Apple totals: 130 release external IDs, 239 track external IDs, 267 candidates, 267
  evidence rows, 239 appearance sources, 130 artwork rows, 40 new canonical releases, 61 new
  canonical tracks, and 239 canonical feed items with Apple evidence.
- Release mix: 95 singles, 12 EPs, five albums, four remixes, and 14 credited features.
- Apple album completeness is now preserved. Exact `Track N` placeholders are suppressed only for
  incomplete or future prereleases, named prerelease songs remain discoverable, and future songs
  are persisted as Upcoming. Group headers use the canonical album date and label future dates as
  Expected.
- Production correction for Apple release `6770600098` was transaction-guarded: 11 isolated
  placeholder candidates, appearances, and tracks were removed; two named future songs were
  changed from New to Upcoming; one upcoming album announcement was recorded. The existing April
  song remains New. The feed now shows three named tracks and `Expected 09/25/2026`.
- Matching: 174 exact barcode and position matches, four strict metadata matches, 61 new canonical
  tracks, and 28 manual-review candidates. Duplicate checks are zero across provider IDs,
  candidates, evidence, appearances, and feed dedupe keys.
- No incomplete Apple request events, unfinished artist rows, active batches, leases, queue entries,
  cooldowns, or stale locks remain.
- Final verification passed: formatting, lint, strict type checking, production build, 352 unit
  tests in 45 files, 91 PostgreSQL integration tests in 16 files, and 25 Playwright tests.
- `pnpm doctor` reports READY with 18 migrations, 834 persisted Apple requests, no Apple lease or
  cooldown, and no stale locks. `git diff --check` and the secret/artifact audit are clean.
- A live local browser smoke test against the migrated production database showed Apple artwork,
  evidence links, provider-neutral matches, candidate reviews, and the candidate-free numeric-ID
  workflow with no browser console errors.

## Implemented But Not Live-Verified

- Apple settings and system-status projections, scan history, feed source filtering, and on-demand
  scan routing are covered by automated tests. The on-demand route was not invoked live because the
  routine production environment intentionally remains Apple-disabled and the completed live scan
  required no additional provider requests.
- Routine unattended Apple scheduling is not implemented.

## Provider And Policy State

- Apple Music is enabled only when server-side credentials are supplied. Production `.env` was not
  modified. The active Apple Developer Program membership is an explicitly approved paid exception.
- Apple scope is public catalog only. No Music User Token, subscriber library, recommendations,
  favorites, playback, playlist access, or mutation exists.
- Apple publishes no numeric request limit in the cited official documentation. The verified local
  policy remains one request at a time and at least 1100 ms between starts.
- Spotify has no active cooldown. Its unpublished Development Mode quota remains a risk. Playlist
  writes remain disabled.
- Reddit remains blocked pending explicit Data API approval. SoundCloud automation, YouTube, and
  TIDAL remain excluded or deferred.
- Spotify's broad cross-service policy language remains unresolved. Provider data and artwork stay
  namespaced, no provider payload is sent to another provider, and no playback or mixed queue exists.

## Known Risks

- Catalog completeness is bounded by confirmed mappings, the configured Apple storefront, first
  view pages, and the 30-day or last-success window. It is not guaranteed.
- Apple may expose unnamed prerelease track slots. The provider now suppresses exact `Track N`
  placeholders, but differently named placeholders would still require a new verified rule.
- 273 watchlist artists still require manual Apple mapping decisions.
- Apple catalog views may legitimately return 404 for absent optional views. The provider now
  verifies the artist when both required discovery views are absent.
- Credentials currently live outside the production worktree and must be configured through a
  secure server environment for routine application use.

## Immediate Next Step

Review and commit the verified Apple prerelease correction, then resolve the highest-priority
pending artist mappings before designing a bounded unattended Apple schedule and deeper catalog
reconciliation.

## Deferred

- Apple user authorization, personal library import, recommendations, playback, favorites, and
  playlist writes.
- Deep Apple catalog pagination, full historical reconciliation, and automatic Apple scheduling.
- Reddit live access, SoundCloud automation, YouTube, TIDAL, multi-user deployment, and commercial
  operation.
