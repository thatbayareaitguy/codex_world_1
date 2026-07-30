# Apple Music Pilot Handoff

Date: 2026-07-29

## Implemented checkpoint

- Branch: `codex/apple-music-discovery`
- Worktree: isolated Apple worktree
- Provider state: implemented, disabled by default, not connected to production execution
- Authentication: developer token only, ES256 with an external P-256 key, memory-only token cache
- API scope: public catalog only
- Database scope: Apple-specific run, request, cache, mapping, catalog, and comparison tables
- Verification scope: synthetic credentials and injected HTTP only

The provider supports artist search and lookup, a maximum 25-artist batch, all six required artist
views, album details, paginated album tracks, and song batches. Every followed path is checked
against the exact Apple catalog allowlist. Request concurrency, pacing, timeouts, response size,
retry, cooldown, cache, and budgets are bounded.

Artist mappings require explicit identity evidence. The frozen 50-artist snapshot may be read as
immutable comparison input, but Apple requests, cache entries, mappings, and results remain
separate from free-iTunes and Spotify state.

## Still prohibited

- live Apple requests under this checkpoint;
- Music User Tokens, `/v1/me`, personal libraries, playback, playlists, and Apple Music Feed;
- artwork or preview download, cache, or playback;
- production scanning, scheduling, feed mutation, UI exposure, or playlist integration;
- Spotify, iTunes, or any other provider request from the Apple pilot;
- merge into `codex/release-radar-hardening`.

No real identifier, token, private-key path, private-key material, or authorization header belongs
in source control, logs, telemetry, or reports.

## Credential-free verification

- Formatting, zero-warning lint, and strict TypeScript passed.
- Unit suite: 50 files and 377 tests passed.
- Apple PostgreSQL suite: 5 tests passed.
- Clean migration, upgrade migration, and no-drift generation passed with 19 migrations.
- All 17 integration files passed independently against a freshly migrated Apple test database,
  for 90 passing tests.
- The aggregate integration command has an existing order-dependent Spotify campaign-fixture leak
  into the Spotify scheduler suite. No Spotify test or product code was changed for this Apple
  milestone.
- Production build passed.
- Mock-only Playwright: 23 tests passed.
- Apple-scoped doctor: `READY`.
- Final Apple development and test database evidence showed zero Apple request events, zero pilot
  runs, zero active leases, and zero active cooldowns.

All Apple HTTP tests used injected responses. No live provider request occurred.

## Next milestone

The exact next milestone is a bounded 25-artist Apple Music live completeness test. It must receive
separate authorization, begin with the provider disabled, define request and runtime limits, check
the persisted cooldown before any request, and stop immediately on a 429. It must not add
production integration.
