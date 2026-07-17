# AI Handoff

Updated: 2026-07-17 16:29:30 PDT (UTC-07:00)

## Repository

- Branch: `codex/release-radar-hardening`
- Latest commit: current `HEAD` (`docs: update handoff after scan correction`). Resolve its immutable hash with `git rev-parse HEAD`.
- Current milestone: combined Spotify hardening and MusicBrainz validation checkpoint complete. Spotify Development Mode live validation remains paused.
- Git state: working tree clean after this handoff commit; branch synchronized with `origin/codex/release-radar-hardening` by the requested push.

## Confirmed Working

- PostgreSQL and Docker development services, migrations, backup, restore, and doctor checks.
- Database-backed canonical watchlist with 593 active follows.
- Spotify OAuth connection and followed-artist import persistence. No Spotify request was made during the latest MusicBrainz tasks.
- Global database-backed MusicBrainz request pacing at one request per second.
- Live one-artist MusicBrainz scan for YUSSI, including incremental progress, heartbeat, cancellation, resume, legitimate no-results persistence, and idempotent rerun.
- YUSSI confirmed MusicBrainz mapping persisted as a user-confirmed mapping. Related reviews are resolved.
- Transactional MusicBrainz confirmation, idempotent reconfirmation, replacement cleanup, persisted-state modal display, and watchlist refresh are covered by database and browser tests.
- Mock scanning, feed filtering, evidence links, artist management, navigation, appearance settings, and guarded Spotify batch controls.

## Implemented, Not Live-Tested

- The revised YUSSI mapping modal has synthetic Playwright coverage but still needs one user-visible verification in the running application.
- Spotify global cooldown enforcement, request queue, bounded pagination, staged batches, pause, cancel, retry, and resume have credential-free coverage but no post-cooldown live Spotify validation.
- Spotify single-playlist write boundary is implemented and tested but writes remain disabled and have not been used against a real account.
- A 10-artist MusicBrainz batch has not run because fewer than 10 artists have confirmed mappings.

## Known Defects And Limitations

- Historical scan `8ae0a233-9bc8-4ad2-b61d-24099507f6f5` was safely reclassified from `failed` to `cancelled` after every guard matched. Its timestamps, counts, artist/provider fields, and original cancellation message were preserved. Doctor no longer reports a failed scan.
- One historical pre-fix MusicBrainz artist-scan telemetry row may retain a doubled stage count. Current batch summaries and new runs are corrected.
- MusicBrainz returned no YUSSI candidates inside the tested 60-day backfill. This is a legitimate no-results state, not proof of completeness.
- Normal MusicBrainz scans are limited to artists with confirmed mappings.
- Spotify Development Mode limits are unpublished, so completion estimates remain ranges and full completeness cannot be claimed.

## Provider Blockers

- Spotify provider cooldown: stored until `2026-07-18T07:38:31.454Z` (`2026-07-18 00:38:31 PDT`). Spotify request count remains zero under the new gate. Do not probe, clear, or bypass the cooldown.
- MusicBrainz: two confirmed mappings. At least 10 total are required before the requested 10-artist batch validation.
- Reddit: disabled pending explicit API approval.
- SoundCloud API, YouTube, Apple Music, TIDAL, and other providers remain excluded. SoundCloud is limited to the disabled-by-default manual outbound-link feature.

## Database

- Applied migrations: 8, through `0007_musicbrainz_workflow`.
- Committed forward migrations: `0006_amusing_power_pack` and `0007_musicbrainz_workflow`, with snapshots and journal updates.
- Clean test-database migration provisioning passes as part of integration tests.
- Current safe counts: 593 active follows and 2 confirmed MusicBrainz mappings.
- Historical failed or partial scans requiring attention: 0. Operation and provider scan locks: 0.

## Verification

Latest complete credential-free verification on 2026-07-17 at approximately 16:04 PDT:

- Format: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across all workspace projects.
- Unit tests: 188 passed in 25 files.
- PostgreSQL integration tests: 19 passed in 3 files.
- Playwright: 10 passed.
- Production build: passed.
- Doctor: `READY`; no failed scans or stale locks. The active Spotify cooldown remains the only provider action notice.
- `git diff --check`: passed.

## Uncommitted Files

- None after this handoff commit. Ignored local credentials, runtime logs, build output, and test artifacts remain outside source control.

## Security And Policy

- Credentials, OAuth tokens, authorization headers, contact email, and raw provider payloads must not enter this document or logs.
- Spotify tokens remain server-side and encrypted at rest. Browser code must not receive provider secrets.
- Spotify playlist writes default off. Future writes are limited to adding exact or manually confirmed tracks to one configured, owned, private playlist.
- No combined player, mixed queue, cross-service artwork, audio proxy, scraping, or SoundCloud API integration is permitted.
- Plain outbound links to another service remain a documented Spotify policy uncertainty. Keep canonical records provider-neutral and Spotify data namespaced.

## Next Action

After the stored Spotify cooldown expires, decide whether to run the one-artist YUSSI Spotify dry-run validation. Do not run it before explicit approval.

## User Decisions Needed

- After the stored Spotify cooldown expires, explicitly approve or defer the one-artist YUSSI Spotify dry-run validation.
- Confirm MusicBrainz mappings for enough artists to permit a 10-artist MusicBrainz batch, or defer that validation.
