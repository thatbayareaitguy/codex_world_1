# AI Handoff

Updated: 2026-07-21 19:29 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest checkpoint: `a2d010cbf4d8bc3e75af9d0fa82e9f08ed4367ae` (`fix: validate resumable Spotify album reconciliation`), pushed to the tracked remote branch.
- Current milestone: historical Spotify album-track reconciliation completed for all 76 stored releases.
- Git state: only this historical completion record is uncommitted pending final verification.

## Confirmed Working

- Phase 1 release appearances and album completeness were verified, committed, and pushed at `7df8830`.
- Feed assembly uses bounded SQL projections plus `Map` and `Set` lookups instead of nested array scans.
- Feed pages are server filtered, search aware, signed-cursor based, and bounded to 25 through 200 items with a default of 100.
- Album and EP groups are the pagination unit. A group may exceed the nominal page size but is never split.
- Release-track completeness remains available to diagnostics and reconciliation but is not rendered as a badge in the Discovery Feed.
- New feed records increment a durable PostgreSQL revision. Visible tabs poll every 15 seconds and on focus; changes show a notice until the user refreshes from the top.
- Loading more appends without duplicates. Changing search, filters, or sort resets pagination.
- Scan history and MusicBrainz mapping reviews use bounded deterministic cursor pages with explicit access to older records.
- Spotify, MusicBrainz, and Reddit evidence use provider-specific HTTPS host, path, and identifier validation. Invalid historical evidence is retained in PostgreSQL but omitted from clickable UI.
- The app is responding on `http://127.0.0.1:3000`.
- Exact release reconciliation accepts only an explicit canonical-release allowlist, uses the shared Spotify request gate, persists every page, resumes from the next offset, and skips already completed releases without provider requests.
- The approved five-release validation completed `Overgrown (Deluxe Edition)` (23/23 tracks), `SOMA` (13/13), `UNTAMED` (12/12), `Inverse` (4/4), and `Hold On` (1/1).
- Interruption and resume were exercised on `Overgrown`: the first page persisted 10 tracks and offset 10, then the resumed run fetched the remaining two pages.
- The exact-five idempotency rerun made zero provider requests and changed no records.
- Feed revision detection and the in-app refresh action preserved the 166-item database feed and displayed the reconciled releases without a full page reload.
- All 71 remaining historical releases completed in five sequential batches of 15, 15, 15, 15, and 11 releases.
- Historical reconciliation made 71 album-track requests and one OAuth refresh in 337.6 seconds. All returned HTTP 200; minimum request-start spacing was 5.010 seconds; no cooldown, retry, playlist, artist-catalog, MusicBrainz, Reddit, or SoundCloud request occurred.
- The final five-release idempotency sample skipped every completed release, made zero provider requests, and changed no records.
- Final UI inspection showed correct release grouping, artwork, Spotify links, revision refresh, zero partial warnings, and no duplicate visible feed anchors.

## Implemented, Not Live-Tested

- Spotify playlist safeguards remain implemented, but writes are disabled and were not exercised.
- The distributed full-watchlist scan has not started.

## Database

- PostgreSQL is healthy with 14 forward migrations applied through `0013_moaning_kid_colt`.
- `0012_common_newton_destine.sql` adds 16 query-specific indexes for feed paging and projection, review loading, scan history, reverse provider lookups, playlist status, coverage reconciliation, and album retrieval resume.
- `0013_moaning_kid_colt.sql` adds the durable feed revision row and transactional triggers for feed-visible tables.
- Clean migration and upgrade from the prior 12-migration schema passed. New index names are unique and at most 63 bytes.
- Reconciliation changed no canonical counts: 76 releases, 148 tracks, 166 appearances, 166 candidates, 166 evidence rows, and 166 feed items.
- Retrieval state is 76 complete. Partial, not-started, in-progress, paused, failed, rate-limited, missing-track, discrepancy, nonterminal-cursor, and unusable-album-ID counts are all zero.
- All persisted album-track items have exact canonical and release-appearance mappings. Duplicate disc/track positions are zero, and 18 legitimate repeated recordings retain distinct release appearances.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all six checked workspace projects.
- Unit tests: 257 passed in 36 files.
- PostgreSQL integration tests: 64 passed in 12 files.
- Production build: passed; 23 pages and routes generated.
- Playwright: 23 passed.
- Doctor: `READY`; 14 migrations, no cooldown, no stale lock, and no unresolved failed scan.
- Synthetic feed page diagnostics passed for 150, 1,000, and 3,000 rows. A 100-item page remained under 1 second and 1 MB; revision lookup was 30.7 ms in the latest focused run.
- Synthetic in-memory assembly at 3,000 rows measured 0.371 ms with indexed lookups versus 59.348 ms with nested scans. These are local synthetic diagnostics, not production claims.
- Historical live reconciliation made 72 provider requests: 71 album-track requests and 1 token refresh. All returned HTTP 200, the minimum request-start interval was 5.010 seconds, and no playlist, artist-catalog, MusicBrainz, Reddit, or SoundCloud request occurred.

## Uncommitted Files

- `docs/AI_HANDOFF.md` records the completed historical reconciliation.

## Security And Policy

- Signed cursors contain ordering positions and a query hash, not SQL or credentials.
- Unsafe provider evidence is never rendered as a link and is not silently deleted.
- Spotify request gating, OAuth scopes, provider boundaries, artwork provenance, matching rules, and playlist safeguards were not changed.
- Spotify playlist writes remain disabled. Reddit and SoundCloud automatic access remain disabled.
- The reconciliation command cannot infer or accept arbitrary provider IDs: each target must resolve from an explicitly supplied canonical release ID.

## Known Limitations

- No historical release was multi-disc, so live ordering was validated only within disc 1.
- Release completeness remains diagnostic metadata and is intentionally not rendered as a feed badge.
- Cursor traversal is a stable historical window. New records are incorporated only after the user accepts the revision notice and refreshes from the top.
- Synthetic performance results do not establish production capacity.

## Next Action

Prepare a separately approved distributed full-watchlist scan plan. Do not start the full watchlist scan as part of this milestone.

## User Decisions Needed

- Decide when to authorize a distributed full-watchlist scan.
