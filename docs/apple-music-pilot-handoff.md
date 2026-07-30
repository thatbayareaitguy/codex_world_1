# Apple Music Pilot Handoff

Date: 2026-07-29

## Implemented checkpoint

- Branch: `codex/apple-music-discovery`
- Worktree: isolated Apple worktree
- Provider state: implemented, disabled by default, executable only through the isolated pilot
  command, and not connected to production execution
- Authentication: developer token only, ES256 with an external P-256 key, memory-only token cache
- API scope: public catalog only
- Database scope: Apple-specific run, request, cache, mapping, catalog, and comparison tables
- Verification scope: synthetic credentials and injected HTTP only

## Bounded live authentication result

The separately authorized authentication and five-artist canary milestone added
`--stop-after-canary` and committed it before network access. The option binds the run to 75
requests and 15 minutes, never creates the full-phase client, and records `canary_completed` only
after a successful canary.

One live BUNT. public-catalog artist lookup returned HTTP 200. Apple therefore accepted the
developer credential, but URL metadata in the returned resource failed the existing safe-URL
validation before identity confirmation. The run stopped `failed/unsafe_url` after one request.
There were zero retries, searches, direct-view calls, pagination calls, album-detail calls, track
calls, mappings, catalog rows, or comparisons. The five-artist canary did not start.

The post-run audit found one parsed-response cache row created before normalization failed. That
single row was removed while sanitized request telemetry and the terminal run result were
preserved. No raw response remains. The lease is released, no cooldown is active, and Apple
remains persistently disabled.

The Apple task did not modify the main or iTunes worktree. The final audit observed unrelated
concurrent uncommitted changes in the iTunes worktree and left them untouched.

See `docs/apple-music-api-canary-evaluation.md` for the sanitized measurements.

The provider supports artist search and lookup, a maximum 25-artist batch, all six required artist
views, album details, paginated album tracks, and song batches. Every followed path is checked
against the exact Apple catalog allowlist. Request concurrency, pacing, timeouts, response size,
retry, cooldown, cache, and budgets are bounded.

The dedicated command forms are:

```powershell
pnpm apple:pilot -- --plan --snapshot <external-snapshot-path>
pnpm apple:pilot -- --execute-live --confirm-live APPLE_PUBLIC_CATALOG_25 --snapshot <external-snapshot-path>
```

Plan mode is credential-free and database-free. Future live execution requires both confirmations,
requires persistent `APPLE_MUSIC_ENABLED=false`, and creates only a command-scoped authorization.
It cannot enable the production scanner.

The tracked manifest pins the expected sanitized snapshot hash, 50-artist source properties, exact
25-artist live cohort, three known public IDs, BUNT. authentication probe, and five-artist canary.
The controller forecasts 55 of 75 canary requests and 217 of 225 complete-run requests before the
first live request. It resolves identity before batching, permits a smaller confirmed batch,
reuses canary work, records terminal status, and releases its run-scoped lease in a finally-safe
path.

Artist mappings require explicit identity evidence. The frozen 50-artist snapshot may be read as
immutable comparison input, but Apple requests, cache entries, mappings, and results remain
separate from free-iTunes and Spotify state.

## Still prohibited

- any additional live Apple request without a new explicitly bounded milestone;
- Music User Tokens, `/v1/me`, personal libraries, playback, playlists, and Apple Music Feed;
- artwork or preview download, cache, or playback;
- production scanning, scheduling, feed mutation, UI exposure, or playlist integration;
- Spotify, iTunes, or any other provider request from the Apple pilot;
- merge into `codex/release-radar-hardening`.

No real identifier, token, private-key path, private-key material, or authorization header belongs
in source control, logs, telemetry, or reports.

## Credential-free verification

- Focused pilot command and controller suite: 32 tests passed with injected clients and synthetic
  evidence.
- Apple PostgreSQL suite: 7 tests passed, including run-scoped lease retention, explicit release,
  and indefinite 429 cooldown persistence.
- The prior reported campaign-fixture leak did not reproduce in the latest pre-live attempt. One
  fresh aggregate run had two Spotify rate-gate test timeouts. The focused rerun passed 11 of 11,
  and the second fresh aggregate run passed 90 of 90. No Spotify product or test source change was
  required.
- The real plan command validated the exact frozen snapshot and cohort with credentials and
  database configuration removed from its process. Before and after evidence showed zero Apple
  request events, runs, leases, cooldowns, cache rows, mappings, albums, songs, comparisons, and
  imported snapshot rows.
- Formatting, zero-warning lint, and strict TypeScript passed.
- Unit suite: 51 files and 409 tests passed.
- Canonical aggregate PostgreSQL suite: 17 files and 92 tests passed against a freshly reset Apple
  test database. This includes clean and upgrade migration coverage with 19 migrations.
- Migration generation reported no schema drift and created no migration.
- Production build passed.
- Mock-only Playwright: 23 tests passed.
- Apple-scoped doctor: `READY`.
- Final isolated development evidence remained at zero Apple requests, runs, leases, cooldowns,
  cache rows, mappings, albums, songs, comparisons, and imported snapshots.

All Apple HTTP tests used injected responses. No live provider request occurred.

## Next milestone

The next source milestone should reproduce and resolve the `unsafe_url` normalization stop using
credential-free, sanitized fixtures and official public-catalog URL rules. Source must not be
changed under the completed live milestone. Any later authentication retry or canary requires a
new explicitly bounded authorization. A complete 25-artist test is not justified because no
five-artist canary measurements exist.
