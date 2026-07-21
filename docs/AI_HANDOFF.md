# AI Handoff

Updated: 2026-07-21 15:39 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`.
- Latest commit: `HEAD` (`feat: preserve release appearances and album completeness`).
- Current milestone: first pre-sync correction milestone completed; second pre-sync scaling and evidence-validation milestone is next.
- Git state: the Phase 1 checkpoint is committed. The working tree was clean before beginning Phase 2.

## Confirmed Working

- PostgreSQL is healthy with 12 forward migrations applied through `0011_gigantic_power_man`.
- One canonical recording can have distinct, provenance-backed appearances on a single, album, deluxe album, compilation, remix, EP, or reissue without duplicating recording identity.
- Feed grouping resolves releases through appearances, scopes evidence to each appearance, and orders tracks by disc, track number, provider order, title, and ID.
- Spotify album-track pages persist before the next provider request. Interrupted work resumes from the stored offset and does not duplicate completed pages or tracks.
- Release completion requires a terminal cursor, matching unique track count, persisted pages, and no unresolved error. Historical releases remain conservatively partial until reconciled.
- Missing or changed Spotify artist mappings block only the affected batch artist. Restoring the confirmed mapping makes that artist retryable without selecting a replacement automatically.
- Keep separate creates or retains a distinct canonical recording, appearance, evidence, feed item, and manual decision. Repeating the decision is idempotent.
- Expanded album and EP groups render the release artwork on every track card as well as in the group header. Collapsing the group retains the compact header artwork.
- The production build is running at `http://127.0.0.1:3000`. Its database feed returns 166 appearance-backed items with completeness state.

## Data Repair

- Before migration: 64 releases, 148 tracks, 75 provider release mappings, 166 provider track mappings, 166 candidates, 166 evidence rows, and 148 feed rows.
- After guarded repair: 76 releases, 148 tracks, 76 provider release mappings, 166 provider track mappings, 166 appearances, 166 appearance-source rows, 166 candidates, 166 evidence rows, and 166 feed rows.
- No existing canonical release or track ID was changed. Existing evidence, candidates, artwork, external IDs, manual decisions, first-seen timestamps, and feed state fields were preserved.
- Proven multi-release examples now include SPEAKERBOX on both BLOODBATH AND BEYOND and SPEAKERBOX, plus the verified Overgrown deluxe/remix appearances.
- One manually confirmed candidate missing its exact Spotify release mapping was repaired idempotently. No matched candidate now lacks provable release provenance, and no title-only association was inferred.
- Historical album retrieval rows: 0 complete, 76 partial, 76 awaiting reconciliation, 0 missing-track count, and 76 conservative historical discrepancies.

## Implemented, Not Live-Tested

- No live provider validation was permitted for this milestone. Album-track pagination and resume behavior use typed fixtures and injected HTTP responses.
- All historical Spotify releases require a later bounded reconciliation before they can become complete.
- Spotify playlist safeguards remain implemented, but writes are disabled and were not exercised.

## Known Limitations

- The compatibility column `tracks.release_id` remains in the schema but is deprecated and no longer authoritative. A later compatibility-reviewed migration may remove it.
- Historical album-track page details did not exist before this migration, so migrated releases cannot be called complete until Spotify reconciliation runs.
- Feed pagination, broad performance cleanup, provider URL validation, and distributed watchlist synchronization remain outside this milestone.

## Provider State

- Spotify: connected; no cooldown, active scan, stale lock, or provider process. Playlist writes remain disabled.
- MusicBrainz: configured but not called.
- Reddit: disabled pending explicit approval and not called.
- SoundCloud API and all other excluded providers were not called.

## Verification

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 238 passed in 32 files.
- PostgreSQL integration tests: 50 passed in 9 files, including clean migration, 11-to-12 upgrade, guarded repair, pagination resume, mapping blockage, and Keep separate coverage.
- Production build: passed; 23 pages and routes generated.
- Playwright: 20 passed, including per-track grouped artwork, appearance grouping, completeness indicators, blocked mapping state, and Keep separate retention.
- Doctor: `READY`; 12 migrations, no cooldown, no stale lock, playlist writes disabled, and the historical completeness diagnostic reported accurately.
- `git diff --check`: passed after the final handoff update.
- No live provider or playlist request occurred during implementation or verification.

## Security And Policy

- The migration and tests contain no credentials, tokens, authorization headers, provider payloads, personal account data, full artwork URLs, dumps, backups, logs, screenshots, or traces.
- The pre-migration custom-format backup is outside source control at the application backup location.
- All future Spotify album-track reconciliation must continue through the shared PostgreSQL-backed gate at one request at a time and at least five seconds between starts.

## Next Action

Implement the separately authorized second pre-sync correction milestone without starting a full watchlist sync.

## User Decisions Needed

- Review the uncommitted second pre-sync correction milestone after its verification report.
- Do not authorize live reconciliation or the full Spotify watchlist sync until the second correction milestone is complete.
