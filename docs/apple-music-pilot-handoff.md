# Apple Music Pilot Handoff

Date: 2026-07-30

## Implemented checkpoint

- Branch: `codex/apple-music-discovery`
- Worktree: isolated Apple worktree
- Provider state: implemented, disabled by default, executable only through the isolated pilot
  command, and not connected to production execution
- Authentication: developer token only, ES256 with an external P-256 key, memory-only token cache
- API scope: public catalog only
- Database scope: Apple-specific run, request, cache, mapping, catalog, and comparison tables
- Verification scope: credential-free tests plus one bounded live HTTP 200 authentication lookup
  that stopped on `unsafe_url` before identity confirmation, followed by a credential-free URL and
  cache-ordering correction and one bounded HTTP 200 retry

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

The retained evidence cannot identify the rejected value or exact field path. Code-path
reconstruction rules out artist `attributes.url`. The failure category was response navigation
metadata validated by `assertAllowedAppleMusicPath` and `assertAllowedAppleMusicUrl`, with
`data[].relationships.albums.href` the strongest exact-path match. That relationship link was not
followed.

The correction keeps strict validation on every API request target, followed resource path, and
pagination value. It separately discards descriptive sharing URLs, non-followed relationship
links, resource-reference links, and unknown URL-bearing fields. Cache writes now occur only after
schema validation, request-capable URL validation, and complete normalization. Unsafe URL, schema,
or normalization failures create no cache entry and retain only fixed-category telemetry.

## Bounded retry result

The 2026-07-30 retry started from
`40a985e3cb6d58f024ae291f6684a4a43a1f4803`. Pre-live formatting, zero-warning lint, strict
TypeScript, and 71 focused Apple tests passed. Apple doctor was `READY` with 20 migrations. The
plan validated the pinned snapshot, exactly 25 artists, the exact five-artist canary, a 55-of-75
forecast, zero requests, and zero writes.

One new BUNT. artist lookup returned HTTP 200. The descriptive and non-followed URL correction
worked, but normalization stopped on the exact request-capable field
`relationships.albums.next`. Sanitized telemetry classified it as relative HTTPS pagination on
the allowed Apple API host with an `outside_allowlist` decision. The value itself was not
persisted or reported. Identity comparison did not run, so BUNT. was not confirmed and the
five-artist canary did not start.

The run ended `failed/unsafe_url` after one request and 201 ms. It made zero searches, direct-view,
followed-pagination, album-detail, or track requests, with zero retries and zero cache hits.
Concurrency was one; a request-start interval could not be measured from one request. The lease
was released, no cooldown was created, and Apple remained persistently disabled.

The corrected cache ordering succeeded live: zero cache, mapping, album, song, and comparison rows
were created. No raw response, descriptive URL, artwork, preview, token, credential, or
authorization header was persisted. No remaining cohort artist or other provider was contacted.

## Embedded-pagination correction

The exact second failure field, `relationships.albums.next`, was embedded navigation metadata from
the artist identity response. The runner never follows that relationship because the pilot
retrieves the six approved artist views explicitly. Normalization had incorrectly treated every
relationship `next` as request-capable.

The credential-free correction makes embedded relationship navigation inert and removes it before
cache persistence. Explicit pagination is limited to the artist-view and album-track operations.
Each cursor must match its operation, route family, US storefront, resource identity, and artist
view where applicable. The transport rejects redirects, and the grammar rejects cross-host,
cross-operation, cross-identity, `/v1/me`, library, unsupported-resource, unsupported-query, and
duplicate-page paths.

Verification passed 425 unit tests, 80 focused Apple tests, 9 Apple PostgreSQL tests, 94 aggregate
integration tests, formatting, zero-warning lint, strict TypeScript, the production build, 23
mock-only Playwright tests, migration drift checks, Apple doctor, and `git diff --check`. The
synthetic HTTP 200 reproduction produced usable identity and exactly one sanitized cache row.
Unsafe pagination produced zero cache or result rows and released the lease.

No live request occurred during this correction. The real Apple request-event total remains two,
Apple remains persistently disabled, and no other provider or production path was contacted.

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

- Focused pilot command and controller suite: 33 tests passed with injected clients and synthetic
  evidence.
- Apple PostgreSQL suite: 8 tests passed, including zero-cache unsafe pagination, sanitized
  telemetry, run-scoped lease retention, explicit release, and indefinite 429 cooldown
  persistence.
- The prior reported campaign-fixture leak did not reproduce in the latest pre-live attempt. One
  fresh aggregate run had two Spotify rate-gate test timeouts. The focused rerun passed 11 of 11,
  and the second fresh aggregate run passed 90 of 90. No Spotify product or test source change was
  required.
- The real plan command validated the exact frozen snapshot and cohort with credentials and
  database configuration removed from its process. Before and after evidence showed zero Apple
  request events, runs, leases, cooldowns, cache rows, mappings, albums, songs, comparisons, and
  imported snapshot rows.
- Formatting, zero-warning lint, and strict TypeScript passed.
- Unit suite: 51 files and 417 tests passed.
- Canonical aggregate PostgreSQL suite: 17 files and 93 tests passed against a freshly reset Apple
  test database. This includes clean and upgrade migration coverage with 20 migrations.
- Migration generation reported no schema drift and created no migration.
- Production build passed.
- Mock-only Playwright: 23 tests passed.
- Apple-scoped doctor: `READY`.
- At that credential-free checkpoint, isolated development evidence remained at zero Apple
  requests, runs, leases, cooldowns, cache rows, mappings, albums, songs, comparisons, and imported
  snapshots.

All credential-free Apple HTTP tests used injected responses. The later separately authorized
retry made exactly one live Apple request and stopped before the canary.

## Next milestone

The operation-scoped live retry from
`12ec1a4910fea9557549b13c6a3c358720306284` authenticated BUNT. successfully, normalized and
cached the response without embedded navigation, and confirmed BUNT. identity. It then mapped
1991 and Alok as ambiguous and NURKO as search-confirmed before NURKO's first explicit
`latest-release` view returned HTTP 400. The run stopped `failed/http_error` after five starts,
with four HTTP 200 responses, one HTTP 400 response, no retry, no pagination, concurrency one,
a 1,109 ms minimum start interval, and a 4,609 ms persisted runtime.

G-Space and the remaining 20 cohort artists were not contacted. No artist completed all six
views, so recall and a revised full-run ceiling remain unavailable. The prior 217-of-225
synthetic forecast is not validated, and 225 is not justified as sufficient.

The next milestone must be credential-free diagnosis and correction of the explicit
artist-view incompatibility. No further live request is authorized. A future live canary requires
new bounded authorization after focused tests pass. The complete cohort, representative cohort,
production integration, and merge remain unauthorized.
