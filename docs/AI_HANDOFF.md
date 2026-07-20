# AI Handoff

Updated: 2026-07-19 22:24:12 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`
- Latest commit: `feat: refine discovery feed interactions` (current `HEAD` checkpoint).
- Current milestone: the approved 15-artist staged Spotify validation and Mefjus idempotency spot check are complete. Feed density and per-item/per-release collapse controls are validated; no two-page or larger batch has started.
- Git state: the reviewed feed preference, presentation, and validation changes are committed locally. The checkpoint has not been pushed.
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
- Expanded feed cards use a denser 84-pixel cover, reduced spacing, and smaller metadata hierarchy. The fixed expanded-card minimum height is removed, and Evidence shares the provider/availability row instead of occupying an otherwise empty row.
- Every feed item has a keyboard-operable chevron with `aria-expanded`. Collapsing produces a one-line row about 47 pixels high and hides secondary evidence, facts, and export details without changing item state.
- Multi-track release headers have an independent keyboard-operable chevron. Collapsing `Overgrown (Deluxe Edition)` produced a 42-pixel album bar and hid all 21 track cards; expanding restored the group.
- Responsive browser inspection at 480 pixels found no card or document overflow. Browser console errors: 0.
- Feed summary metrics are database-backed: New this week counts all persisted feed items first seen since Monday, Upcoming counts releases dated within the next 30 days, and the since-last-scan value uses the latest scan insertion count. Search, tab, and advanced filters do not alter these totals.
- Live browser inspection after the 15-artist scan shows 66 new items this week, 0 upcoming in the next 30 days, and +0 from the latest idempotent Spotify scan.
- Discovery Feed cards no longer display match confidence or match reasons. Confidence and its rationale remain visible in the Review Queue where a user decision is required.
- Spotify evidence links remain separate from regional playback availability. An evidence link can exist while the configured-region availability state is unavailable.
- Feed cards omit the redundant New badge. Upcoming, Saved, Listened, Dismissed, Needs Review, release type, and provider badges remain available when applicable.
- The Spotify scan-status section has the same keyboard-operable chevron disclosure pattern as feed rows. Its scan name and current status remain visible when collapsed; detailed counters, scheduling text, and scan actions are hidden.
- Feed state badges now include extensible provider-source tags derived from source evidence. Spotify-backed YUSSI items show a Spotify tag while playback availability remains separately labeled.
- The exact idempotency rerun made one `artist_albums` request and created zero records or duplicates.
- Spotify batch `7a4b6bde-4899-41d6-ab69-a59abf0ee37f` processed only Basstripper, SHY FX, Camo & Krooked, K Motionz, and Noisia sequentially with one page per artist and a 60-day backfill.
- The batch persisted `Under The Lights` by Basstripper plus `Just Love` and `DARE TO DREAM` featuring SHY FX: 3 canonical releases, 3 tracks, 3 evidence rows, 3 feed items, and 0 review items.
- Camo & Krooked, K Motionz, and Noisia produced legitimate zero-candidate first-page results. All five scans are partial because another provider page exists.
- The SHY FX idempotency spot check used one `artist_albums` request and created zero candidates or duplicate records.
- Spotify batch `f0226fea-1618-4926-81f3-1bf6cae12f82` processed exactly the 15 approved artists sequentially with one page per artist and a backfill start of 2026-05-20. All 15 persisted as partial, with zero failed, cancelled, or rate-limited rows.
- The 15-artist batch discovered 60 observations and persisted 58 distinct candidates, 58 evidence rows, 13 canonical releases, 49 canonical tracks, 50 feed rows, and 1 review row. Two already-seen candidate identities were skipped without duplication.
- A.M.C, Disclosure, Grafix, Netsky, and Porter Robinson produced legitimate zero-candidate first-page results. The bounded partial scans do not prove later pages contain no recent release.
- Multi-track UI groups include `Overgrown (Deluxe Edition)` with 21 tracks and `SOMA` with 13 tracks. The database feed contains 49 non-review canonical track rows plus one separate ambiguous review row for `Want It - Mefjus Remix`.
- The Mefjus idempotency rerun made one successful `artist_albums` request and created or changed no discovery records.
- Forward migration 0009 adds nullable per-artist total-release and backfill-eligible release counts. New scans persist both counts; synthetic unit and PostgreSQL integration coverage confirm the wiring.
- MusicBrainz pacing, confirmed mapping persistence, review resolution, cancellation, resume, and live one-artist validation.
- Mock scanning, artist management, feed filters, evidence links, navigation, appearance settings, and guarded Spotify batch controls.

## Implemented, Not Live-Tested

- Two-page Spotify scanning and batches larger than 15 artists have not run.
- Spotify playlist writes remain disabled and have never been used against the real account.
- Deep Spotify reconciliation and the full watchlist scan have not run.
- A 10-artist MusicBrainz batch has not run because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Spotify scan `eeadfa36-2f08-491a-adbb-144b94a15720` remains `failed` with its original timestamp-binding diagnostic evidence. Its metadata now marks it resolved after the fix and successful live validation; doctor excludes resolved historical failures from active problems.
- The first non-dry YUSSI request encountered a local `request_failed` event, then refreshed OAuth successfully and recovered. No 429 or provider cooldown resulted.
- The first Basstripper request repeated the same recoverable local `request_failed` pattern, refreshed OAuth, and succeeded on retry. Telemetry recorded no 429 or cooldown.
- The first 1991 request in the 15-artist batch repeated the recoverable local `request_failed` pattern after about 30 seconds, refreshed OAuth, and succeeded on retry. No 429 or cooldown resulted.
- YUSSI remains partially scanned because the approved page limit was one and another Spotify page exists.
- Basstripper, SHY FX, Camo & Krooked, K Motionz, and Noisia remain partially scanned because the staged page limit was one and another Spotify page exists. Zero candidates on a partial scan do not prove the artist has no recent release on later pages.
- All 15 artists in batch `f0226fea-1618-4926-81f3-1bf6cae12f82` remain partial because the page limit was one and each response indicated another page.
- The five-artist batch ran before migration 0009, so its exact returned-release summary counts were not retained. Those historical fields remain null rather than being inferred or fabricated; future scans persist them.
- Normal scans intentionally omit old first-page releases outside the 60-day backfill. Completeness cannot be guaranteed under bounded pagination or unpublished Spotify Development Mode limits.
- Spotify availability displayed as unavailable for these records in the configured US region even though evidence links are present. This was not changed during discovery validation.
- Canonical feed cards continue to use provider-neutral generated covers. Spotify artwork is not used for cross-provider canonical records under the current policy boundary.
- One historical pre-fix MusicBrainz artist-scan row may retain a doubled stage count.
- The feed does not automatically reload server-provided items after an external scanner process finishes. A full page reload changed the visible count from 16 to 66 and exposed the persisted 15-artist results.
- Feed item, album, and Spotify scan-status collapse state is session-local UI state and resets after a page reload. Collapsing an entire album unmounts its track rows, so previously collapsed child rows reopen when the album is expanded.

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
- Fifteen-artist staged baseline: 0 releases, tracks, candidates, evidence rows, feed items, or review items for the approved artists.
- Fifteen-artist staged result: 13 releases, 49 tracks, 58 distinct candidates, 58 evidence rows, 50 feed rows, and 1 review row. Candidate statuses are 49 new, 8 matched, and 1 needs review.
- The Mefjus rerun left the 15-artist totals unchanged and created zero duplicate releases, tracks, candidates, evidence, feed, or review rows.
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
- Browser coverage confirms item collapse/expand through mouse and keyboard, `aria-expanded` state, hidden expanded details, and a collapsed height below 60 pixels. Live database validation confirmed independent 47-pixel item rows and 42-pixel album rows.
- Browser coverage confirms the feed summary changes from 3 to 4 new items and from +0 to +1 after a mock scan, keeps 1 upcoming item, and remains unchanged when search hides every feed card.
- Browser coverage confirms percentage matches are absent from Discovery Feed cards and 90% confidence remains visible for the synthetic Review Queue item.
- Browser coverage confirms New badges are absent initially and remain absent after Save and Listened preferences are toggled off.
- Browser coverage confirms Spotify scan status collapses with mouse input, hides counters and actions, reports `aria-expanded=false`, and expands from keyboard Enter input. The final full Playwright rerun passed all 10 tests.
- Browser coverage confirms a representative expanded card stays below 140 pixels, its Evidence link remains visible inside the provider row, and collapsed rows remain below 60 pixels.
- Five-artist batch duration: 70.5 seconds. Request events: 10 total, comprising 6 `artist_albums` attempts, 3 `album` requests, and 1 OAuth refresh. Minimum request-start interval was 5,008 ms; HTTP 429 and playlist request counts were zero.
- Per-artist provider request counts excluding the OAuth refresh: Basstripper 3, SHY FX 3, Camo & Krooked 1, K Motionz 1, and Noisia 1.
- UI inspection confirmed all 3 new feed records, protected Spotify evidence links, separate release and first-seen dates, no duplicate feed entries, and visible `Partial: 5` batch status.
- Post-batch SHY FX spot check: 1 request, 0 candidates, 0 inserts, 0 playlist requests, and no count changes.
- Fifteen-artist batch duration: 201.2 seconds persisted time and 203.2 seconds command wall time. Safe request telemetry recorded 36 requests: 16 `artist_albums` attempts, 19 `album` requests, and 1 OAuth refresh. Minimum request-start interval was 5,005 ms; HTTP 429 and playlist request counts were zero.
- Stored per-artist request counts: 1991 3; A.M.C 1; Culture Shock 2; Delta Heavy 2; Disclosure 1; Friction 3; Grafix 1; Hybrid Minds 2; IMANU 2; Kanine 2; Mefjus 3; Netsky 1; Pola & Bryson 5; Porter Robinson 1; Skrillex 6. The OAuth refresh is the thirty-sixth safe request event.
- Live UI inspection confirmed a feed count of 66 after reload, representative entries for the approved artists, seven release groups, protected Spotify evidence, one clearly separated Needs Review row, and no playlist action.
- Post-batch Mefjus spot check: 1 successful `artist_albums` request, 0 discoveries, 0 inserts, 0 skips, 0 review items, and no database count changes.

## Uncommitted Files

- None after the local checkpoint commit.

## Security And Policy

- Credentials, tokens, authorization headers, contact email, and raw provider payloads remain excluded from source, handoff text, and reports.
- Spotify tokens remain encrypted and server-side. All live requests used the shared cooldown and request gate.
- Spotify playlist writes remain disabled; no playlist read or write occurred during validation.
- No MusicBrainz or Reddit request occurred during Spotify validation.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain external links to another service remain a documented Spotify policy uncertainty.

## Next Action

Correct automatic post-scan feed refresh before considering a guarded two-page test on a small subset. Do not start a larger batch or the full watchlist scan.

## User Decisions Needed

- Decide whether automatic feed refresh after scanner completion should be implemented before further live scanning.
- Approve or defer a future two-page Spotify test on a small subset after reviewing this result.
- Confirm enough MusicBrainz mappings for a 10-artist batch, or defer that validation.
