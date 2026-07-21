# AI Handoff

Updated: 2026-07-21 01:00:22 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest commit: the current `fix: validate Spotify artwork backfill` commit (hash finalized by the amend that includes this handoff update). Previous pushed artwork checkpoint: `88404da`.
- Current milestone: Spotify album and single artwork plus the bounded historical artwork backfill are implemented. The approved five-release live validation and final credential-free verification passed.
- Git state: clean after the validation-fix amend on `codex/release-radar-hardening`; normal push remains.

## Confirmed Working

- PostgreSQL, both Docker database services, ten forward migrations, the local web application, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth, followed-artist import, global cooldown, one shared request gate, bounded pagination, persisted per-artist progress, safe telemetry, and partial-scan reporting.
- Earlier YUSSI, five-artist, and 15-artist validations completed without HTTP 429 or playlist access.
- Approved batch `03290ef4-4fd3-4086-bf4a-d69379514837` processed exactly 50 artists serially from 2026-07-20 21:04:55 to 21:13:51 PDT.
- The batch made 102 accounted requests, observed a 5.004-second minimum request-start interval, and made no playlist, MusicBrainz, or Reddit request.
- The batch inspected 500 release summaries, found 51 backfill releases, and persisted 90 candidates, 46 new releases, 83 new tracks, 90 evidence rows, 84 feed rows, and 1 review row.
- All 50 artists persisted after completion; 22 had legitimate zero-result scans and all 50 are partial because another page existed beyond the approved one-page limit.
- The Alison Wonderland idempotency rerun made one artist-albums request and created zero canonical, candidate, evidence, feed, or review duplicates.
- The idle Discovery Feed defaults to the most recent meaningful multi-artist batch while preserving later single-artist scans, dry runs, and failed, cancelled, paused, and completed history in an accessible selector.
- The live status panel displays the 50-artist batch with scan ID, timing, duration, trigger, provider, artist count, 102 requests, 90 created records, 0 updated records, 50 partial artists, 0 failures, 1 review item, and non-dry-run status.
- New Spotify candidates retain validated album artwork URL and dimensions from the already-fetched official album response without another Spotify request. Release metadata is namespaced under `release_external_ids.provider_fields.spotify`.
- The Discovery Feed loads Spotify artwork directly from `i.scdn.co`, preserves aspect ratio, links to the matching Spotify album, shows one cover per grouped release, and uses the existing fallback for missing or failed images.
- `pnpm spotify:backfill-artwork` defaults to dry-run, requires a limit from 1 through 25, requires `--apply` for writes, uses only stored album IDs, shares the global Spotify request gate, and persists a resumable cursor after each completed release.
- The live backfill selects distinct canonical releases even when several Spotify album IDs converge on one canonical release. Feed projection chooses a valid stored artwork record across those IDs.
- The running feed displayed new Au5, BARELY ALIVE, and Dom Dolla-related records with Spotify evidence and release grouping without a page reload.
- Feed artist credits use commas and expanded or collapsed headings use `Artist(s) - Song`.
- Expanded and collapsed feed headings append a precision-aware release date at normal weight. Day-precision dates use `Weekday, M/D/YY`; the redundant released-date fact is removed and remaining metadata aligns with the title.
- Multi-track album and EP group headings use `Artist - Release`, including matching accessible collapse and expand labels.
- Manual match decisions persist transactionally and the feed polls a lightweight database revision before fetching updated feed data.
- BRANDON is confirmed as MusicBrainz artist `5b9fdf2d-1610-41f9-bc73-3a0cdd289eba` (`German DJ Brandon Hovsepian`) from exact Spotify and Instagram URL relationships. The five unrelated proposals are rejected, the confirmed review is persisted, and the artist page displays the mapping after reload.

## Implemented, Not Live-Tested

- The automatic feed-revision polling path remains covered by Playwright; live UI verification used a newly opened tab after apply, so the no-reload transition itself was not directly observed in that tab.
- Spotify playlist safeguards exist, but writes remain disabled and have never been exercised against the real account.
- Deep reconciliation and the remaining watchlist scan have not run.
- A 10-artist MusicBrainz batch remains deferred because only 6 artists have confirmed mappings.

## Known Defects And Limitations

- One-page scans cannot prove catalog completeness; all 50 approved artists remain partial.
- One initial artist-albums request failed while refreshing an expired access token, then retried successfully. Safe telemetry preserves both events.
- Spotify availability can show unavailable for the configured region while a protected evidence link exists.
- 59 canonical Spotify-backed releases still lack artwork after the approved five-release limit. They continue to use the initials fallback.
- One historical Spotify timestamp-binding failure remains resolved and preserved.
- The real `Want It - Mefjus Remix` review remains unresolved because no prior manual decision existed in PostgreSQL.

## Provider State

- Spotify: connected; no active cooldown, operation lock, scan lock, or queued request after validation.
- MusicBrainz: configured; 6 confirmed mappings. The targeted BRANDON investigation made 9 official API requests, all HTTP 200.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 10 through `0009_first_white_queen`. Artwork uses existing JSONB provider fields, so no migration was required.
- Before live backfill: 0 Spotify release rows had valid artwork, 75 lacked artwork, all 75 had usable stored Spotify album IDs, and 0 required rediscovery before querying.
- After live backfill: 5 provider release rows and 5 canonical releases have valid artwork; 70 provider rows remain without artwork, representing 59 eligible canonical releases. Canonical totals remain 64 releases and 148 tracks; evidence remains 166 and feed items remain 149 with 0 duplicate feed keys.
- Post-validation totals: 64 releases, 148 tracks, 166 candidates, 166 evidence rows, and 149 feed rows.
- Duplicate provider candidates, evidence identities, and feed dedupe keys: 0.
- Active operation locks: 0. Active scan locks: 0.
- BRANDON mapping reviews: 1 confirmed, 5 rejected, and 0 pending.
- Validation details and all 50 per-artist outcomes are in `docs/spotify-validation-sample.md`.

## Verification

- Live 50-artist batch: completed; HTTP 429: 0; playlist requests: 0; provider failures: 0.
- Idempotency spot check: completed with zero data writes.
- Browser feed inspection: passed with new grouped results and no visible error state.
- Scan-history regression checks: API unit coverage, PostgreSQL-backed default-selection coverage, and two Playwright flows passed. Live browser inspection confirmed the 50-artist batch is the idle default and single-artist scans remain selectable.
- BRANDON MusicBrainz validation: exact Spotify and Instagram URL relationships resolved to one MBID; persistence, review closure, page reload, and confirmed-state modal passed. Spotify requests during this investigation: 0.
- Feed title-date layout: lint, strict TypeScript, formatting, targeted Playwright, desktop browser inspection, and 480px responsive inspection passed. Metadata and evidence offsets match the title at 0px; no horizontal page overflow was introduced.
- Grouped release heading: targeted Playwright passed for expanded and collapsed states; the live database feed rendered `Au5 - Inverse` and the matching accessible region label.
- Spotify artwork unit coverage: URL and album-link validation, closest-size selection, malformed metadata, missing images, provider candidate propagation, and safe schema filtering passed.
- Spotify artwork PostgreSQL coverage: namespaced persistence, shared album records, idempotent URL refresh, evidence/feed dedupe, missing/unsafe handling, and non-Spotify isolation passed.
- Artwork backfill coverage: dry-run write isolation, apply persistence, existing-artwork and malformed-ID skips, unsafe URL rejection, resume, idempotency, cooldown and 429 stops, sequential processing, canonical identity stability, and feed revision updates passed.
- Live dry-run: selected `UNTAMED`, `Hold On`, `Under The Lights`, `Just Love`, and `DARE TO DREAM`; predicted 5 updates and wrote 0. An expired-token refresh exposed token acquisition occurring after the album lease; 6 album attempts plus 1 OAuth request completed without 429.
- The token path now refreshes before acquiring an API permit or starting the request timeout. Focused regression tests passed.
- Live apply after correction: 5 album requests, 20.328 seconds, 5.009-second minimum request-start interval, 19.135 seconds aggregate queue wait, 5 updates, 0 unavailable, 0 failures, 0 HTTP 429, and 0 playlist requests.
- Live UI: all five images projected; `Hold On` loaded at 300 by 300 pixels; grouped `UNTAMED` rendered one image; links use the matching Spotify album with `_blank` and `noopener noreferrer`; object fit is `contain`; collapse works; no horizontal overflow; and non-artwork records retain initials.
- Spotify artwork Playwright coverage: direct rendering, safe album link, refresh persistence, one grouped image, collapse, failure fallback, and 480px layout passed.
- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 224 passed in 31 files.
- PostgreSQL integration tests: 32 passed in 6 files.
- Production build: passed; 23 application pages/routes generated.
- Playwright: 17 passed.
- Doctor: `READY`; 10 migrations, no cooldown, no stale lock, and one resolved historical failure preserved.
- `git diff --check`: passed.

## Uncommitted Files

- None after the validation-fix amend.

## Security And Policy

- No credential, token, authorization header, personal provider payload, database dump, backup, log, screenshot, or trace is committed or documented.
- Spotify tokens remain encrypted and server-side. Playlist writes remain disabled.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted. Spotify artwork remains Spotify-namespaced, loads directly from the exact allowed host, is not downloaded or transformed, and links back to Spotify.
- Plain outbound links to another service remain a documented Spotify policy uncertainty.

## Next Action

Push the validation-fix commit normally. The deeper pagination milestone may then begin only with a separately reviewed and explicitly approved bounded plan; do not backfill another release or scan the remaining watchlist as part of this milestone.

## User Decisions Needed

- Decide the correct review outcome for `Want It - Mefjus Remix`.
- Approve a future pagination/reconciliation strategy before any additional Spotify scan.
