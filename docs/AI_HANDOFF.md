# AI Handoff

Updated: 2026-07-19 22:55:00 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest commit: `feat: improve discovery feed and staged scan visibility` (current `HEAD`).
- Current milestone: automatic database-feed refresh is implemented and verified. The approved three-artist, two-page Spotify dry run has not started.
- Git state: feed refresh implementation, tests, and handoff are committed locally and ready to push.

## Confirmed Working

- PostgreSQL, Docker services, ten forward migrations, the local application, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth, followed-artist import, global cooldown, shared request gate, bounded pagination, persisted partial scans, and safe request telemetry.
- YUSSI one-page dry and non-dry validation, a five-artist staged scan, and a 15-artist staged scan completed without HTTP 429 or playlist access.
- The 15-artist scan persisted 58 candidates, 58 evidence rows, 13 releases, 49 tracks, 50 feed rows, and 1 review row. Its Mefjus idempotency check created no duplicates.
- Compact feed cards, independent Save and Listened controls, release grouping, item and album collapse, source badges, dynamic feed metrics, and collapsible Spotify status.
- The browser now checks a lightweight PostgreSQL feed revision every 15 seconds while visible and immediately on focus. It fetches the full feed only after a revision change.
- External feed inserts merge by feed-item ID without a page reload, duplicate item, filter reset, search reset, sort reset, collapsed-row reset, or practical scroll jump.
- A manual Refresh feed control reports current, updated, and error states. Existing discoveries remain visible after a refresh error.
- Scanner completion uses the same in-app feed refresh instead of `window.location.reload()`.
- Browser coverage proves a synthetic external insert appears without reload and preserves active filter, search, sort, and item collapse state.

## Implemented, Not Live-Tested

- Automatic feed refresh is covered by API and Playwright tests but has not yet been observed during a live external scanner process.
- Two-page Spotify scanning has not run.
- Spotify playlist writes remain disabled and have never been used against the real account.
- Deep Spotify reconciliation and the full watchlist scan have not run.
- A 10-artist MusicBrainz batch remains deferred because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Normal Spotify scans use bounded pagination and cannot guarantee completeness.
- Existing one-page staged artists remain partial when Spotify reported another page.
- Spotify availability may be unavailable in the configured region even when protected Spotify evidence links exist.
- Canonical feed cards intentionally use generated provider-neutral covers rather than Spotify artwork.
- Feed, album, and scan-status collapse state is session-local and resets after a page reload.
- One historical Spotify timestamp-binding failure remains preserved and marked resolved; doctor excludes it from active failures.

## Provider Cooldowns And Blockers

- Spotify: no active cooldown, no active scan, and no stale lock as of this update.
- MusicBrainz: configured; only two confirmed mappings are available for batching.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 10, through `0009_first_white_queen`.
- Active operation and scan locks: 0.
- Duplicate canonical artists, provider release IDs, provider track IDs, evidence identities, and non-review feed tracks: 0 at the latest staged validation.
- Feed revision detection uses feed-item count plus maximum `updated_at`; it does not query a provider.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 199 passed in 28 files.
- PostgreSQL integration tests: 26 passed in 3 files.
- Playwright: 11 passed.
- Production build: passed; 23 application routes/pages generated.
- Doctor: `READY`; 10 migrations, no cooldown, no stale lock, and one resolved historical failure preserved.
- `git diff --check`: passed.
- Browser test isolation was corrected so mock review-queue coverage no longer depends on pending MusicBrainz rows in the development database.

## Uncommitted Files

- None before the approved dry run.

## Security And Policy

- No credential, token, authorization header, contact email, raw provider payload, dump, backup, log, trace, or screenshot is included.
- Feed refresh uses only server-side PostgreSQL reads and never calls Spotify, MusicBrainz, Reddit, or another provider.
- Spotify tokens remain encrypted and server-side. Playlist writes remain disabled.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain external links to another service remain a documented Spotify policy uncertainty.

## Next Action

Create and push `feat: improve discovery feed and staged scan visibility`, then rerun doctor and perform only the approved three-artist, two-page Spotify dry run.

## User Decisions Needed

- Review the dry-run results before approving any non-dry two-page scan or larger batch.
