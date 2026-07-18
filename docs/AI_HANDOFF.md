# AI Handoff

Updated: 2026-07-18 16:54:23 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`
- Latest commit: current `HEAD` (`fix: stabilize Spotify request deferral and live scanning`).
- Current milestone: one-artist Spotify persistence and idempotency validation complete; five-artist staged validation has not started.
- Git state: the validated checkpoint is committed locally and not pushed. The branch is one commit ahead of `origin/codex/release-radar-hardening` before any later amend.

## Confirmed Working

- PostgreSQL, Docker services, nine forward migrations, application port, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth connection, followed-artist import, global cooldown, shared request gate, bounded pagination, persisted partial scans, and provider request telemetry.
- YUSSI one-page dry run and one-page non-dry discovery through the live Spotify API without HTTP 429 or playlist access.
- The first non-dry scan persisted 15 Spotify candidates as 13 canonical tracks under 2 releases: `Hold On` and the 12-track `UNTAMED` album. Two repeated single/album recordings were matched to their canonical album tracks.
- The feed shows `Hold On` dated 2026-07-16 with YUSSI credit and protected Spotify evidence links. `UNTAMED` renders as one 12-track release group.
- One canonical non-review feed item is enforced per user and track. All 15 provider candidates and evidence rows remain preserved.
- The exact idempotency rerun made one `artist_albums` request and created zero records or duplicates.
- MusicBrainz pacing, confirmed mapping persistence, review resolution, cancellation, resume, and live one-artist validation.
- Mock scanning, artist management, feed filters, evidence links, navigation, appearance settings, and guarded Spotify batch controls.

## Implemented, Not Live-Tested

- Five-artist and larger staged Spotify batches have not run.
- Spotify playlist writes remain disabled and have never been used against the real account.
- Deep Spotify reconciliation and the full watchlist scan have not run.
- A 10-artist MusicBrainz batch has not run because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Spotify scan `eeadfa36-2f08-491a-adbb-144b94a15720` remains `failed` with its original timestamp-binding diagnostic evidence. Its metadata now marks it resolved after the fix and successful live validation; doctor excludes resolved historical failures from active problems.
- The first non-dry YUSSI request encountered a local `request_failed` event, then refreshed OAuth successfully and recovered. No 429 or provider cooldown resulted.
- YUSSI remains partially scanned because the approved page limit was one and another Spotify page exists.
- Normal scans intentionally omit old first-page releases outside the 60-day backfill. Completeness cannot be guaranteed under bounded pagination or unpublished Spotify Development Mode limits.
- Spotify availability displayed as unavailable for these records in the configured US region even though evidence links are present. This was not changed during discovery validation.
- One historical pre-fix MusicBrainz artist-scan row may retain a doubled stage count.

## Provider Cooldowns And Blockers

- Spotify: no active cooldown and no stale lock. The preserved cooldown expired at `2026-07-18T07:38:31.454Z`.
- MusicBrainz: two confirmed mappings; ten are needed for the requested 10-artist batch.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. Manual SoundCloud links remain disabled by default.

## Database

- Applied migrations: 9, through `0008_groovy_wolfsbane`.
- Migration 0008 removes only redundant non-review feed presentation rows, preserves the earliest first-seen timestamp and latest feed state, then enforces canonical feed uniqueness.
- YUSSI baseline before non-dry validation: 0 Spotify releases, tracks, candidates, evidence rows, feed items, or review items; provider request count 12.
- YUSSI after validation and idempotency rerun: 1 canonical artist, 1 Spotify artist mapping, 2 canonical releases, 13 canonical tracks, 15 release candidates, 15 evidence rows, 13 feed items, 0 review items, and provider request count 20.
- Duplicate canonical artists, provider release IDs, provider track IDs, evidence identities, and non-review feed tracks: 0.
- Active operation and scan locks: 0.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 192 passed in 26 files.
- PostgreSQL integration tests: 25 passed in 3 files.
- Playwright: 10 passed.
- Production build: passed; 22 routes/pages generated.
- Doctor: `READY`; 9 migrations applied, no cooldown or stale lock, and 1 resolved historical failure preserved.
- `git diff --check`: passed.
- First non-dry request events: one failed local `artist_albums` attempt, one successful `oauth_token` refresh, one successful `artist_albums` retry, and four successful `album` requests. Successful request starts respected at least five seconds spacing. HTTP 429 count: 0. Playlist request count: 0.
- Idempotency rerun: one successful `artist_albums` request, zero inserted records, and no count changes.

## Uncommitted Files

- None expected after the handoff amendment. Verify with `git status`.

## Security And Policy

- Credentials, tokens, authorization headers, contact email, and raw provider payloads remain excluded from source, handoff text, and reports.
- Spotify tokens remain encrypted and server-side. All live requests used the shared cooldown and request gate.
- Spotify playlist writes remain disabled; no playlist read or write occurred during validation.
- No MusicBrainz or Reddit request occurred during Spotify validation.
- No combined player, mixed queue, scraping, cross-service artwork, audio proxy, or SoundCloud API integration is permitted.
- Plain external links to another service remain a documented Spotify policy uncertainty.

## Next Action

Review and commit the current validated change set, then decide whether to approve a five-artist Spotify staged test. Do not start a larger batch until the five-artist request count and timing are reviewed.

## User Decisions Needed

- Approve or defer the five-artist Spotify staged validation.
- Confirm enough MusicBrainz mappings for a 10-artist batch, or defer that validation.
