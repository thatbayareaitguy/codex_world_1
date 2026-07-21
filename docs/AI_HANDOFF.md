# AI Handoff

Updated: 2026-07-20 22:26:49 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest commit: current `feat: validate larger Spotify batches and improve scan history` checkpoint.
- Current milestone: the approved 50-artist Spotify validation and read-only scan-history correction are complete and fully verified. The artwork milestone and remaining watchlist scan have not started.
- Git state: the current checkpoint is committed locally and ready to push to `origin/codex/release-radar-hardening`. Unrelated review and feed presentation work remains uncommitted.

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
- The running feed displayed new Au5, BARELY ALIVE, and Dom Dolla-related records with Spotify evidence and release grouping without a page reload.
- Feed artist credits use commas and expanded or collapsed headings use `Artist(s) - Song`.
- Expanded and collapsed feed headings append a precision-aware release date at normal weight. Day-precision dates use `Weekday, M/D/YY`; the redundant released-date fact is removed and remaining metadata aligns with the title.
- Multi-track album and EP group headings use `Artist - Release`, including matching accessible collapse and expand labels.
- Manual match decisions persist transactionally and the feed polls a lightweight database revision before fetching updated feed data.
- BRANDON is confirmed as MusicBrainz artist `5b9fdf2d-1610-41f9-bc73-3a0cdd289eba` (`German DJ Brandon Hovsepian`) from exact Spotify and Instagram URL relationships. The five unrelated proposals are rejected, the confirmed review is persisted, and the artist page displays the mapping after reload.

## Implemented, Not Live-Tested

- Spotify playlist safeguards exist, but writes remain disabled and have never been exercised against the real account.
- Deep reconciliation and the remaining watchlist scan have not run.
- A 10-artist MusicBrainz batch remains deferred because only 6 artists have confirmed mappings.

## Known Defects And Limitations

- One-page scans cannot prove catalog completeness; all 50 approved artists remain partial.
- One initial artist-albums request failed while refreshing an expired access token, then retried successfully. Safe telemetry preserves both events.
- Spotify availability can show unavailable for the configured region while a protected evidence link exists.
- Provider-neutral feed cards intentionally do not use Spotify artwork.
- One historical Spotify timestamp-binding failure remains resolved and preserved.
- The real `Want It - Mefjus Remix` review remains unresolved because no prior manual decision existed in PostgreSQL.

## Provider State

- Spotify: connected; no active cooldown, operation lock, scan lock, or queued request after validation.
- MusicBrainz: configured; 6 confirmed mappings. The targeted BRANDON investigation made 9 official API requests, all HTTP 200.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 10 through `0009_first_white_queen`.
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
- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 205 passed in 29 files.
- PostgreSQL integration tests: 28 passed in 4 files.
- Production build: passed; 23 application pages/routes generated.
- Playwright: 14 passed.
- Doctor: `READY`; 10 migrations, no cooldown, no stale lock, and one resolved historical failure preserved.
- `git diff --check`: passed.

## Uncommitted Files

- `apps/scanner/src/scan.integration.test.ts`
- `apps/web/app/api/feed-items/[id]/route.test.ts`
- `apps/web/app/api/feed-items/[id]/route.ts`
- `apps/web/app/globals.css`
- `apps/web/app/radar-shell.tsx`
- `apps/web/e2e/feed.spec.ts`
- `packages/db/src/index.ts`
- `packages/db/src/review-decisions.ts`

## Security And Policy

- No credential, token, authorization header, personal provider payload, database dump, backup, log, screenshot, or trace is committed or documented.
- Spotify tokens remain encrypted and server-side. Playlist writes remain disabled.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain outbound links to another service remain a documented Spotify policy uncertainty.

## Next Action

Begin the provider-neutral artwork milestone only after reviewing its scope. A later, separately approved validation must test deeper pagination and reconciliation before the remaining watchlist scan.

## User Decisions Needed

- Decide the correct review outcome for `Want It - Mefjus Remix`.
- Approve the artwork design before implementation and a future pagination/reconciliation strategy before any additional Spotify scan.
