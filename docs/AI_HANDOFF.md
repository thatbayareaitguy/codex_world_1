# AI Handoff

Updated: 2026-07-19 19:17:25 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`
- Latest commit: current `HEAD` (`feat: validate staged Spotify batch scanning`).
- Current milestone: five-artist staged Spotify validation and one-artist idempotency spot check complete; 15-artist candidate selection is next and live validation has not started.
- Git state: local and remote `codex/release-radar-hardening` contain the staged Spotify validation commit; unrelated feed preference and presentation work remains uncommitted.
- Stash state: no stash exists. The prior feed-work stash was restored and dropped before the instructions for this phase arrived; no stash operation occurred during this phase.

## Confirmed Working

- PostgreSQL, Docker services, nine forward migrations, application port, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth connection, followed-artist import, global cooldown, shared request gate, bounded pagination, persisted partial scans, and provider request telemetry.
- YUSSI one-page dry run and one-page non-dry discovery through the live Spotify API without HTTP 429 or playlist access.
- The first non-dry scan persisted 15 Spotify candidates as 13 canonical tracks under 2 releases: `Hold On` and the 12-track `UNTAMED` album. Two repeated single/album recordings were matched to their canonical album tracks.
- The feed shows `Hold On` dated 2026-07-16 with YUSSI credit and protected Spotify evidence links. `UNTAMED` renders as one 12-track release group.
- One canonical non-review feed item is enforced per user and track. All 15 provider candidates and evidence rows remain preserved.
- Save and Listened are independent, reversible, database-backed preferences. Both can be active simultaneously without replacing the primary New, Upcoming, Dismissed, or Needs Review state.
- Active Save uses a filled green bookmark, an active green control state, and a Saved badge. Active Listen uses its own pressed state and Listened badge. Both controls expose state-aware accessible names and `aria-pressed`.
- Live UI validation saved and listened to `Can't Stop`, removed only Listened, and confirmed after reload that Save remained persisted while Listened remained clear.
- Multi-track releases now render beneath a distinct release header with a release-type icon, title, date, track count, and continuous grouping rail. Live browser inspection confirmed the 12-track `UNTAMED` album is visually grouped.
- Feed state badges now include extensible provider-source tags derived from source evidence. Spotify-backed YUSSI items show a Spotify tag while playback availability remains separately labeled.
- The exact idempotency rerun made one `artist_albums` request and created zero records or duplicates.
- Spotify batch `7a4b6bde-4899-41d6-ab69-a59abf0ee37f` processed only Basstripper, SHY FX, Camo & Krooked, K Motionz, and Noisia sequentially with one page per artist and a 60-day backfill.
- The batch persisted `Under The Lights` by Basstripper plus `Just Love` and `DARE TO DREAM` featuring SHY FX: 3 canonical releases, 3 tracks, 3 evidence rows, 3 feed items, and 0 review items.
- Camo & Krooked, K Motionz, and Noisia produced legitimate zero-candidate first-page results. All five scans are partial because another provider page exists.
- The SHY FX idempotency spot check used one `artist_albums` request and created zero candidates or duplicate records.
- Forward migration 0009 adds nullable per-artist total-release and backfill-eligible release counts. New scans persist both counts; synthetic unit and PostgreSQL integration coverage confirm the wiring.
- MusicBrainz pacing, confirmed mapping persistence, review resolution, cancellation, resume, and live one-artist validation.
- Mock scanning, artist management, feed filters, evidence links, navigation, appearance settings, and guarded Spotify batch controls.

## Implemented, Not Live-Tested

- A 15-artist staged Spotify batch and larger batches have not run.
- Spotify playlist writes remain disabled and have never been used against the real account.
- Deep Spotify reconciliation and the full watchlist scan have not run.
- A 10-artist MusicBrainz batch has not run because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Spotify scan `eeadfa36-2f08-491a-adbb-144b94a15720` remains `failed` with its original timestamp-binding diagnostic evidence. Its metadata now marks it resolved after the fix and successful live validation; doctor excludes resolved historical failures from active problems.
- The first non-dry YUSSI request encountered a local `request_failed` event, then refreshed OAuth successfully and recovered. No 429 or provider cooldown resulted.
- The first Basstripper request repeated the same recoverable local `request_failed` pattern, refreshed OAuth, and succeeded on retry. Telemetry recorded no 429 or cooldown.
- YUSSI remains partially scanned because the approved page limit was one and another Spotify page exists.
- Basstripper, SHY FX, Camo & Krooked, K Motionz, and Noisia remain partially scanned because the staged page limit was one and another Spotify page exists. Zero candidates on a partial scan do not prove the artist has no recent release on later pages.
- The five-artist batch ran before migration 0009, so its exact returned-release summary counts were not retained. Those historical fields remain null rather than being inferred or fabricated; future scans persist them.
- Normal scans intentionally omit old first-page releases outside the 60-day backfill. Completeness cannot be guaranteed under bounded pagination or unpublished Spotify Development Mode limits.
- Spotify availability displayed as unavailable for these records in the configured US region even though evidence links are present. This was not changed during discovery validation.
- Canonical feed cards continue to use provider-neutral generated covers. Spotify artwork is not used for cross-provider canonical records under the current policy boundary.
- One historical pre-fix MusicBrainz artist-scan row may retain a doubled stage count.

## Provider Cooldowns And Blockers

- Spotify: no active cooldown and no stale lock. The preserved cooldown expired at `2026-07-18T07:38:31.454Z`.
- MusicBrainz: two confirmed mappings; ten are needed for the requested 10-artist batch.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 10, through `0009_first_white_queen`.
- Migration 0008 removes only redundant non-review feed presentation rows, preserves the earliest first-seen timestamp and latest feed state, then enforces canonical feed uniqueness.
- Migration 0009 adds nullable `release_count` and `backfill_release_count` fields to Spotify artist-scan telemetry without rewriting historical rows.
- YUSSI baseline before non-dry validation: 0 Spotify releases, tracks, candidates, evidence rows, feed items, or review items; provider request count 12.
- YUSSI after validation and idempotency rerun: 1 canonical artist, 1 Spotify artist mapping, 2 canonical releases, 13 canonical tracks, 15 release candidates, 15 evidence rows, 13 feed items, 0 review items, and provider request count 20.
- Five-artist staged baseline: 0 Spotify releases, tracks, candidates, evidence rows, feed items, or review items for each selected artist.
- Five-artist staged result: 3 releases, 3 tracks, 3 candidates, 3 evidence rows, 3 feed items, and 0 review items. No candidate was outside the 60-day backfill.
- The SHY FX rerun left its totals unchanged at 2 releases, 2 tracks, 2 candidates, 2 evidence rows, and 2 feed items.
- Duplicate canonical artists, provider release IDs, provider track IDs, evidence identities, and non-review feed tracks: 0.
- Active operation and scan locks: 0.
- `Can't Stop` currently has primary state `new`, a persisted `saved_at` timestamp, and no `listened_at` timestamp.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 196 passed in 27 files.
- PostgreSQL integration tests: 26 passed in 3 files.
- Playwright: 10 passed.
- Production build: passed; 22 routes/pages generated.
- Doctor: `READY`; 10 migrations applied, no cooldown or stale lock, and 1 resolved historical failure preserved.
- `git diff --check`: passed.
- First non-dry request events: one failed local `artist_albums` attempt, one successful `oauth_token` refresh, one successful `artist_albums` retry, and four successful `album` requests. Successful request starts respected at least five seconds spacing. HTTP 429 count: 0. Playlist request count: 0.
- Idempotency rerun: one successful `artist_albums` request, zero inserted records, and no count changes.
- Feed preference API tests: 3 passed. The browser flow covers Save, Listen, both active, Unsave, Unlisten, independent filters, active styling, and accessible pressed states.
- Browser coverage confirms Spotify source tags appear only on Spotify-backed fixtures. Live visual inspection confirmed the `UNTAMED` album header and provider tag hierarchy.
- Five-artist batch duration: 70.5 seconds. Request events: 10 total, comprising 6 `artist_albums` attempts, 3 `album` requests, and 1 OAuth refresh. Minimum request-start interval was 5,008 ms; HTTP 429 and playlist request counts were zero.
- Per-artist provider request counts excluding the OAuth refresh: Basstripper 3, SHY FX 3, Camo & Krooked 1, K Motionz 1, and Noisia 1.
- UI inspection confirmed all 3 new feed records, protected Spotify evidence links, separate release and first-seen dates, no duplicate feed entries, and visible `Partial: 5` batch status.
- Post-batch SHY FX spot check: 1 request, 0 candidates, 0 inserts, 0 playlist requests, and no count changes.

## Uncommitted Files

- Modified: `apps/scanner/src/scan.integration.test.ts`, `apps/web/app/globals.css`, `apps/web/app/radar-shell.tsx`, `apps/web/e2e/feed.spec.ts`, `apps/web/lib/feed-server.ts`, `packages/core/src/types.ts`, `packages/db/src/index.ts`, and `packages/testing/src/fixtures.ts`.
- Untracked: `apps/web/app/api/feed-items/[id]/route.ts`, `apps/web/app/api/feed-items/[id]/route.test.ts`, and `packages/db/src/feed-preferences.ts`.

## Security And Policy

- Credentials, tokens, authorization headers, contact email, and raw provider payloads remain excluded from source, handoff text, and reports.
- Spotify tokens remain encrypted and server-side. All live requests used the shared cooldown and request gate.
- Spotify playlist writes remain disabled; no playlist read or write occurred during validation.
- No MusicBrainz or Reddit request occurred during Spotify validation.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain external links to another service remain a documented Spotify policy uncertainty.

## Next Action

Select and present 15 locally eligible artists, then wait for explicit approval before creating or running the staged Spotify batch. Do not start a two-page test or the full watchlist scan.

## User Decisions Needed

- Approve or defer a 15-artist Spotify staged validation.
- Confirm enough MusicBrainz mappings for a 10-artist batch, or defer that validation.
- Commit or defer the separate validated feed preference and presentation changes after the staged Spotify work is reviewed.
