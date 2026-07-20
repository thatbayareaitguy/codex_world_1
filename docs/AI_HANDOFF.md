# AI Handoff

Updated: 2026-07-19 23:29:00 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest checkpoint subject: `fix: normalize discovery feed artist credits`.
- Current milestone: automatic database-feed refresh and the approved three-artist, two-page Spotify dry run are complete. No non-dry two-page scan or larger batch has started.
- Git state: the artist-credit correction is the current checkpoint; later working-tree changes are intentionally excluded.

## Confirmed Working

- PostgreSQL, Docker services, ten forward migrations, the local application, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth, followed-artist import, global cooldown, shared request gate, bounded pagination, persisted partial scans, and safe request telemetry.
- YUSSI one-page dry and non-dry validation, a five-artist staged scan, and a 15-artist staged scan completed without HTTP 429 or playlist access.
- The 15-artist scan persisted 58 candidates, 58 evidence rows, 13 releases, 49 tracks, 50 feed rows, and 1 review row. Its Mefjus idempotency check created no duplicates.
- Compact feed cards, independent Save and Listened controls, release grouping, item and album collapse, source badges, dynamic feed metrics, and collapsible Spotify status.
- The browser checks a lightweight PostgreSQL feed revision every 15 seconds while visible and immediately on focus. It fetches the full feed only after a revision change.
- External feed inserts merge by feed-item ID without a page reload, duplicate item, filter reset, search reset, sort reset, collapsed-row reset, or practical scroll jump.
- A manual Refresh feed control reports current, updated, and error states. Existing discoveries remain visible after a refresh error.
- Scanner completion uses the same in-app feed refresh instead of `window.location.reload()`.
- Browser coverage proves a synthetic external insert appears without reload and preserves active filter, search, sort, and item collapse state.
- Feed artist credits use comma delimiters. Multiple featured credits retain one `feat.` marker; the live feed renders `IMANU, Stabbed by Angels` for the reported multi-artist track.
- Spotify dry-run batch `99dcca0e-1ece-481a-b144-170d8b094ae1` processed only K Motionz, Disclosure, and Porter Robinson, in that order, with two catalog pages each and a 2026-05-20 backfill start.
- Each artist returned 20 releases across two pages. All 60 were older than the backfill start, so the dry run selected no details and produced zero candidates, ambiguous matches, or rejected in-window candidates.
- The batch completed in 60.4 persisted seconds and remained partial for all three artists because each second page indicated another page.

## Implemented, Not Live-Tested

- Automatic feed refresh is covered by API and Playwright tests but has not yet been observed during a live external scanner process.
- A non-dry two-page Spotify scan has not run.
- Spotify playlist writes remain disabled and have never been used against the real account.
- Deep Spotify reconciliation and the full watchlist scan have not run.
- A 10-artist MusicBrainz batch remains deferred because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Normal Spotify scans use bounded pagination and cannot guarantee completeness.
- Existing one-page staged artists remain partial when Spotify reported another page.
- K Motionz, Disclosure, and Porter Robinson remain partial in dry-run telemetry because the approved limit was two pages and Spotify reported another page.
- Spotify availability may be unavailable in the configured region even when protected Spotify evidence links exist.
- Canonical feed cards intentionally use generated provider-neutral covers rather than Spotify artwork.
- Feed, album, and scan-status collapse state is session-local and resets after a page reload.
- One historical Spotify timestamp-binding failure remains preserved and marked resolved; doctor excludes it from active failures.

## Provider Cooldowns And Blockers

- Spotify: no active cooldown, no active scan, and no stale lock after the two-page dry run. The preserved historical cooldown timestamp remains expired.
- MusicBrainz: configured; only two confirmed mappings are available for batching.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 10, through `0009_first_white_queen`.
- Active operation and scan locks: 0.
- Duplicate canonical artists, provider release IDs, provider track IDs, evidence identities, and non-review feed tracks: 0 at the latest staged validation.
- Feed revision detection uses feed-item count plus maximum `updated_at`; it does not query a provider.
- Dry-run batch telemetry: 3 artists completed as partial, 6 pages, 60 release observations, 0 backfill-eligible releases, and 0 candidates.
- Canonical counts were unchanged by the dry run: 18 releases, 65 tracks, 76 candidates, 76 evidence rows, and 66 feed items.
- Existing provider data does not need rewriting for artist-credit formatting; display values are derived from ordered canonical `track_credits` rows.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 202 expected for this checkpoint in 29 files; the full working tree passed 204 in 29 files.
- PostgreSQL integration tests: 26 expected for this checkpoint in 3 files; the full working tree passed 27 in 3 files.
- Playwright: 11 expected for this checkpoint; the full working tree passed 12.
- Production build: passed; 23 application routes/pages generated.
- Doctor: `READY`; 10 migrations, no cooldown, no stale lock, and one resolved historical failure preserved.
- `git diff --check`: passed.
- Two-page dry run: 7 accounted requests and 8 safe telemetry events. Events were 7 `artist_albums` attempts and 1 `oauth_token` refresh; one initial attempt ended as `request_failed`, then six catalog pages returned HTTP 200.
- Minimum request-start interval: 5,008 ms. HTTP 429: 0. Playlist endpoints: 0. MusicBrainz requests: 0. Canonical writes: 0.

## Uncommitted Files

- Later review-persistence and feed-heading work remains outside this checkpoint.

## Security And Policy

- No credential, token, authorization header, contact email, raw provider payload, dump, backup, log, trace, or screenshot is included.
- Feed refresh uses only server-side PostgreSQL reads and never calls Spotify, MusicBrainz, Reddit, or another provider.
- Spotify tokens remain encrypted and server-side. Playlist writes remain disabled.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain external links to another service remain a documented Spotify policy uncertainty.

## Next Action

Select exactly 50 untested artists from the local PostgreSQL watchlist, then wait for explicit approval before any live Spotify request.

## User Decisions Needed

- Approve or revise the exact 50-artist sample before the staged one-page Spotify batch.
