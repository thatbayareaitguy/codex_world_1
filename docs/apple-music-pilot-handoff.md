# Apple Music Pilot Handoff

## Current state

The current checkpoint implements the credential-free full-watchlist identity artifact intake,
zero-network plan, durable mapping precedence, resumable Stage A campaign, and sanitized review
outputs. The immutable artifact contains exactly 593 artists: 307 high-confidence seeds, 13
evidence-supported seeds, 272 ambiguous seeds, and one artist requiring manual review without a
candidate. Every supplied catalog ID remains an unconfirmed candidate.

The real plan reuses 27 existing durable mappings. Stage A therefore has 293 candidate IDs to
validate in 12 batches of at most 25, under a 40-start, ten-minute gate with concurrency one and a
1,100 millisecond pacing floor. It can call only the multiple-artist catalog lookup. Search,
pagination, release discovery, and other providers are unreachable. Stage B is plan-only and is
not authorized for live execution. Historical Apple starts remain 222 and the provider remains
persistently disabled.

Discovery on the five newly confirmed seed artists is complete. The exact scope was ZHU, Don
Diablo, SISTO, William Black, and YUSSI, representing eight frozen in-scope releases. The run
reused all five durable `existing_id_confirmed` mappings and found all eight releases as exact
matches.

The run made 20 fresh starts, four per artist, under the 25-start and five-minute gate. Nineteen
responses were HTTP 200 and SISTO `full-albums` returned one nonterminal HTTP 404. Runtime was
21,528 milliseconds, concurrency was one, and minimum pacing was 1,104 milliseconds. There were
zero retries, cache hits, mapping requests, identity searches, pagination requests, detail
requests, or other-provider requests. The lease is released, the queue is empty, no cooldown
exists, historical Apple starts are 222, and `APPLE_MUSIC_ENABLED=false`.

Combined 25-artist evidence is now 17 of 21 full-cohort exact recall and 17 of 20 mapped-artist
exact recall. Mapping is 17 of 25, primary recall is 12 of 13, matcher misses are zero, one Alok
release remains mapping-unevaluable, and the three prior catalog misses remain. The bounded
thresholds were met. The next separate milestone should request a sanitized full-watchlist public
Apple/iTunes artist-ID candidate artifact from the free-iTunes workstream. Production integration
and merge remain unauthorized.

## Mapping bootstrap history

The 13-artist mapping-only bootstrap is implemented and the authorized live run is complete. The
independent unused-resolver finding was confirmed. The shared catalog-evidence
resolver previously had only test callers. The mapping bootstrap was plan-only, and the normal
recent cold-start path stopped at multiple exact-name ambiguity. Both paths now use the same
resolver through a Top Songs evidence adapter, while recurring confirmed mappings remain immutable.

The exact live gate is `APPLE_RECENT_MAPPING_BOOTSTRAP_13`. The command is restricted to the
self-hashed 13-artist artifact, five seed identity lookups, and two fixed Top Songs first pages for
each of eight unseeded artists. The forecast is 21 starts under a 25-start and 60-second hard gate,
with concurrency one, at least 1,100 milliseconds between starts, no search, no discovery, no
pagination, and no retry. The run made exactly 21 starts, all HTTP 200, in 24,383 milliseconds. All
five seeds were confirmed and all eight two-candidate cases remained ambiguous. Historical Apple
HTTP starts are 202, safe mapping is 17 of 25, and `APPLE_MUSIC_ENABLED=false`.

Unresolved output is sanitized to artist name, candidate counts, evidence scores, overlap and
conflict counts, score gap, classification, and manual-review reason. Numeric catalog IDs remain
outside committed reports. Production integration and merge remain unauthorized.

The result is below the 20-artist lower evaluation indicator. The next separate milestone should
request a sanitized full-watchlist public-ID candidate export from the free-iTunes branch because
all five approved seeds validated, while the first-page Top Songs candidate strategy confirmed
none. The export must remain immutable candidate evidence and every ID must be independently
validated on this Apple branch. No iTunes request or artifact creation occurred here.

Date: 2026-08-03

## Current checkpoint

The isolated recent-release MVP and `optimized_four_source` profile are implemented. The current
25-artist evidence is 17 of 21 full-cohort and 17 of 20 mapped-artist exact recall, with zero
matcher misses. The exhaustive `apple:pilot`, production scanner, scheduler, feed, and default
recent profile remain unchanged.

- Branch: `codex/apple-music-discovery`
- Five-artist milestone starting checkpoint: `92de802140ff7a9c7c8aca675492f09a6629d045`
- Current Apple HTTP-start total: 222
- Latest run: `completed/recent_optimized_seed_discovery_5_completed`, 20 new starts, 21,528 ms
- Runtime state: provider disabled, no active run, lease, cooldown, or queue
- Production integration and merge: not authorized

The original 25-artist live run produced 12 search-confirmed and 13 ambiguous mappings. The
mapping bootstrap later confirmed five seeds, and the bounded discovery run found all eight of
their frozen releases. Eight identities remain ambiguous, one release is mapping-unevaluable, and
the three remaining mapped misses are catalog misses. The current bounded thresholds are met.

The validation was an intentional cold-start name-search stress test. Its manifest supplied no
public IDs, its runner constructed all entries as search-required, and none of the 13 artists had
a prior confirmed mapping for the frozen snapshot. The existing-ID path was intact but had no seed
to validate.

A tracked identity-bootstrap artifact freezes all 13 ambiguity records. Five approved offline
public-ID seeds were independently confirmed by one Apple artist lookup each. Eight artists used
deterministic two-candidate shortlists from retained Apple search evidence and remained ambiguous.
The live bootstrap made its exact 21 planned starts under the 25-start and 60-second ceiling, with
no search, release discovery, pagination, or retry.

The prior generic remix search omitted `limit`, which invoked Apple's documented default of five
results per requested type. Sanitized evidence proved the remaining MUST DIE! remix was absent
from the separate album and song collections. The new request keeps the generic canonical-artist
term, sets the documented maximum `limit=25`, makes one request per artist, and does not
paginate.

The bounded optimization run reused all ten confirmed mappings without an Apple mapping request.
It made ten fresh minimal `top-songs` requests and ten fresh widened searches. All 20 starts
returned HTTP 200. There were zero retries, pagination requests, detail requests, cache hits, or
other-provider events. Every Top Songs page returned ten resources and a next cursor, which was
recorded but not followed.

Top Songs recovered `LOL OK (Axel Boy Remix)` for MUST DIE! and correctly classified it
`remix_of_watched_artist_by_other`. The widened search did not return it and added no newly
accepted in-window candidate compared with the previous default-size search. The stored
comparison labeled the recovered song Apple-only because it compared the parent album title
instead of the song title. This is one matcher miss after successful discovery, not a catalog
miss or invalid remix direction.

Using prior `singles` and `full-albums` evidence, the optimized four-source strategy found 7 of 7
primary releases, 3 of 3 remixes, and 10 of 10 combined releases. It has four unconfirmed
Apple-only candidates, zero false directional matches, and zero directionally uncertain
in-window candidates. The prior five-source strategy and the same strategy without
`latest-release` each remain at 9 of 10 because `latest-release` supplied no unique accepted
candidate.

The provisional representative-pilot profile is now `singles`, `full-albums`, `top-songs`, and
one widened generic remix search, all first page only. It costs four requests per confirmed
artist. For 593 mapped artists that is 2,372 starts and about 43.5 minutes of minimum pacing time
before processing and retry headroom.

See [apple-music-recent-mvp-evaluation.md](apple-music-recent-mvp-evaluation.md) for the complete
sanitized result and [apple-music-recent-mvp-design.md](apple-music-recent-mvp-design.md) for the
implemented contract.

The next milestone should be the 13-artist mapping-only run described in
`docs/apple-music-recent-validation-25.md`. It must not execute the four-source discovery profile.
No such live run is authorized by this handoff.

## Historical milestone record

The sections below preserve prior implementation, authentication, URL-safety, pagination, HTTP
400, and one-request diagnostic history.

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

Credential identifiers and secret material, including Team ID, Key ID, Media ID, developer
tokens, authorization values, private-key paths, and private-key contents, must never appear in
source control, logs, telemetry, reports, or terminal output.

Public Apple catalog artist, album, and song IDs are non-secret operational lookup values. They
may exist in the tracked pilot manifest, isolated Apple database state, process memory, and local
plan output. They remain excluded from committed evaluation reports, long-retained application
logs, and sanitized request telemetry unless represented by a deterministic hash or fixed
placeholder. Public catalog IDs are not credentials and are not equivalent to Team ID, Key ID,
Media ID, tokens, authorization values, or key material.

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

## One-request artist-view diagnostic result

The credential-free audit confirmed that the prior failed request had the documented method,
Apple Music API host, US storefront placement, artist placement, `/view/` route, and
`latest-release` spelling. It also included the optional `limit` and `with` query keys. Both
query keys were removed so every first artist-view request now uses the minimal documented
shape:

`GET /v1/catalog/us/artists/<artist_id>/view/latest-release`

The retained prior evidence cannot identify which optional parameter or value caused the
earlier HTTP 400. The direct-view parser was verified against a top-level `data` collection and
an optional top-level `next`; it does not require an embedded artist relationship.

After the source, tests, and pre-live documentation were committed and pushed, the authorized
diagnostic mode made exactly one live request. It used the existing confirmed NURKO mapping,
sent no optional query parameters, did not search, did not retry, and did not follow pagination.
Apple returned HTTP 200 with one resource and no top-level `next` cursor.

The real Apple request-event count is now eight. One sanitized normalized probe cache row was
created. No mapping, album, song, comparison, cooldown, or production row was created. The run
completed with `view_probe_completed`, its lease was released, and
`APPLE_MUSIC_ENABLED=false` remains persistently configured. No other artist or provider was
contacted.

No additional live request is authorized. The recommended next milestone is a separately
authorized, bounded decision about the five-artist canary. The complete cohort, representative
cohort, production integration, and merge remain prohibited.
