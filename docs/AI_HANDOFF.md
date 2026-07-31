# AI Handoff

Updated: 2026-07-31

## Repository state

The mapping-only 13-artist bootstrap is implemented and its authorized live run completed. The
existing catalog-evidence resolver is now called by both the fixed-candidate bootstrap and the
normal recent cold-start path when exactly two exact-name or alias candidates remain. Existing
durable mappings return before search or evidence work. The scorer is unchanged: release-title
overlap is weighted three, track overlap contributes up to two, date conflicts block confirmation,
and a safe winner needs a score of at least three and a margin of at least two.

The bootstrap validates the exact ordered self-hashed artifact and the content hash of the approved
seed source. Five seeds each require one matching Apple artist lookup. Eight unseeded artists each
use exactly two fixed Top Songs first pages and the shared resolver. No bootstrap search, release
discovery, pagination, or retry is possible. The exact confirmation is
`APPLE_RECENT_MAPPING_BOOTSTRAP_13`; the plan is 21 starts under a 25-start, 60-second,
concurrency-one gate with 1,100 millisecond pacing.

The live run made exactly 21 starts, all HTTP 200, in 24,383 milliseconds. It recorded five artist
lookups and sixteen artist-view starts, zero retries, zero pagination, zero cache hits, and a 1,103
millisecond minimum interval. All five seeds became `existing_id_confirmed`. All eight candidate
pairs remained ambiguous: six pairs scored 0/0, GRiZ scored 0/1, and Rueben scored 2/0. There were
no release-title overlaps or conflicts. Safe mapping increased from 12 to 17 of 25, or 68.0%.
Eight identities require manual review. Historical Apple starts are 202. The lease is released,
the queue is empty, no cooldown exists, and the provider remains disabled.

The pre-live gate passed formatting, zero-warning lint, strict TypeScript, 500 credential-free
unit tests, 63 focused mapping and bootstrap tests, 99 aggregate PostgreSQL integration tests, 15
focused Apple and migration-upgrade integration tests, the production build, 23 mock-only
Playwright tests, clean migration setup, no-drift schema generation, and doctor `READY` with 21
migrations. The plan confirmed zero requests and writes, five seed lookups, sixteen candidate
evidence pages, and 21 forecast starts. Immediately before checkpointing, the isolated database
still recorded 181 historical starts, no active run, lease, cooldown, or queue, and none of the
exact 13 artists had an existing durable mapping.

The next separate milestone should request a sanitized full-watchlist public-ID candidate artifact
from the free-iTunes branch. Five of five approved seeds validated, while the two-candidate Top
Songs evidence confirmed zero of eight. The Apple branch must treat future IDs as immutable
candidates and independently validate them. Production integration, release discovery rerun, and
merge remain unauthorized.

The isolated `pnpm apple:recent` MVP and its `optimized_four_source` profile are implemented.
Feature-credit and terminal EP normalization are corrected credential-free. The ten-artist
evidence replays at 10 of 10 exact, and the 25-artist evidence replays at 9 of 21 full-cohort and
9 of 12 mapped-artist exact recall. Both replays have zero matcher misses. The exhaustive
`apple:pilot`, existing default recent profile, and all production behavior remain unchanged.

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Normalization milestone starting checkpoint: `74f6e840d3477fd5eb904d0ff55faf9e3f4b761c`
- Upstream: `origin/codex/apple-music-discovery`
- Latest live run: `completed/mapping_bootstrap_completed`
- Current historical Apple HTTP-start total: 202
- Provider state: disabled, no active run, lease, cooldown, or queue

The 25-artist validation completed with 12 search-confirmed and 13 ambiguous mappings. The
credential-free replay now gives 9 of 21 full-cohort exact recall, 9 of 12 mapped-artist exact
recall, zero matcher misses, nine mapping-unevaluable releases, and three mapped catalog misses.
The original live run made 71 starts in 80,292 ms with concurrency one, a 1,103 ms minimum
interval, no retry, no pagination, 69 HTTP 200 responses, and two nonterminal HTTP 404 responses.
The current total remains 181 real Apple starts.

The 13 ambiguous identities resulted from a cold-start name-search stress test. The validation
manifest omitted public IDs and the runner had no prior confirmed mapping for them. The
existing-ID path was not defective. A tracked self-hashed identity artifact contains five
approved offline public-ID seeds and two-candidate cached-search shortlists for the other eight.
Five seeds are now confirmed. The eight fixed candidate pairs remain ambiguous. The run used 21
starts under the 25-start, 60-second ceiling, with no retry or release discovery.

The exact sample remained NURKO, G-Space, BUNT., SampliFire, Vibe Chemistry, BARELY ALIVE,
Habstrakt, MUST DIE!, 1788-L, and 3LAU. All ten confirmed mappings were required before the
client and run were created. The experiment made only ten fresh `top-songs` requests and ten
fresh generic album-and-song searches widened from Apple's default five to the documented
maximum 25 results per type.

All 20 requests returned HTTP 200. There were zero mapping, detail, pagination, retry,
cache-hit, or other-provider requests. Concurrency was one, the minimum start interval was 1,108
milliseconds, and runtime was 21,678 milliseconds. Every Top Songs page returned ten resources
and a next cursor, which was not followed.

Top Songs recovered `LOL OK (Axel Boy Remix)` for MUST DIE! and correctly classified it
`remix_of_watched_artist_by_other`. The widened search did not recover it and added no newly
accepted in-window candidate compared with the earlier default-size search. It continued to
find the known NURKO remix. The stored comparison used the recovered song's parent album title
and therefore marked it Apple-only. This is one matcher miss after successful discovery, not a
catalog miss or invalid remix direction.

Combining frozen `singles` and `full-albums` evidence with fresh Top Songs and widened-search
evidence produced 7 of 7 primary recall, 3 of 3 remix recall, and 10 of 10 combined discovery
recall. There were zero false directional matches and zero directionally uncertain in-window
candidates. Four prior Apple-only candidates remain unconfirmed.

The provisional representative-pilot strategy is `singles`, `full-albums`, `top-songs`, and one
widened generic remix search, all first page only. It costs four requests per confirmed artist:
2,372 starts and about 43.5 minutes of minimum pacing time for 593 mapped artists. A mapping-only
live run is the next proposed experiment, but it is not authorized by this handoff.

See [apple-music-recent-mvp-evaluation.md](apple-music-recent-mvp-evaluation.md) for the complete
sanitized result.

## Runtime isolation

- Compose project: `codex_world_1_apple`
- Compose file: `docker-compose.apple.yml`
- Web port: `3002`
- Development database: `radar_apple` on loopback port `55435`
- Test database: `radar_apple_test` on loopback port `55436`
- PostgreSQL application name: `release-radar-apple`
- Provider default: disabled

The Apple containers, network, volume, database names, ports, request gate, telemetry, cache,
mappings, and comparison rows are separate from Spotify and free-iTunes runtime state. The frozen
iTunes pilot snapshot is immutable input only.

## Implementation

- `AppleDeveloperTokenManager` generates ES256 developer tokens from an external P-256 key, caches
  them only in memory, and refreshes before expiration.
- `AppleMusicClient` permits only exact-host public catalog GET requests and implements artist
  search, single and maximum-25 artist lookup, six artist views, album lookup, paginated album
  tracks, and song batches.
- Every request-capable path is allowlisted. Relative and same-host absolute pagination is reduced
  to an allowed relative path. Pagination is terminal, duplicate-safe, and locally sorted.
- Descriptive Apple sharing URLs, non-followed relationship links, resource-reference links, and
  unknown URL-bearing fields are discarded and never become transport targets or cached data.
- Embedded relationship `href` and `next` fields are inert. Only explicit artist-view and
  album-track operations own pagination, with operation, route, storefront, resource identity,
  view, query-key, redirect, and duplicate-page enforcement.
- A response enters the cache only after schema validation, request-capable URL validation, and
  complete normalization succeed. Unsafe URL, schema, and normalization failures create no cache
  entry.
- The Apple-only database gate enforces concurrency one, at least 1,100 milliseconds between
  starts, request/runtime budgets, safe telemetry, normalized cache reuse, and persisted 429
  cooldowns.
- Mapping and comparison logic is deterministic, evidence-based, and supports the frozen
  50-artist evaluation model.
- `pnpm apple:pilot` provides a file-only plan mode and a separately double-confirmed future live
  mode. The production scanner still explicitly rejects the Apple provider. There is no production
  scheduler, feed mutation, UI, or playlist path.
- `--stop-after-canary` binds a live run to 75 requests and 15 minutes, records
  `canary_completed` only after success, and never creates the full-phase client.
- The tracked manifest pins the exact snapshot shape, 25 artists, three known public IDs, BUNT.
  authentication probe, and the deterministic five-artist canary.
- The live controller uses the existing request gate, cache, mapping, catalog, and comparison
  persistence. It adds a run-scoped lease without changing the schema, reuses canary work, batches
  only confirmed IDs, records sanitized terminal evidence, and releases the lease in a finally-safe
  path.

The focused command/controller suite has 33 passing injected tests. The Apple PostgreSQL file has
8 passing tests. The real plan command validated the frozen snapshot with credential variables
and database configuration removed, and all isolated Apple database counts remained zero.

The prior campaign-fixture leak did not reproduce in the latest pre-live attempt. One fresh
aggregate run had two Spotify rate-gate timeouts, its focused rerun passed 11 of 11, and the second
fresh aggregate run passed 90 of 90. No Spotify source or test correction was required.

Final command-checkpoint verification passed formatting, zero-warning lint, strict TypeScript, 409
unit tests, 92 aggregate integration tests against a fresh Apple test database, clean and upgrade
migration coverage, no-drift migration generation, production build, 23 mock-only Playwright
tests, and Apple doctor `READY`.

The canary-only checkpoint passed 410 unit tests, 33 focused pilot tests, 7 Apple database tests,
92 canonical aggregate integration tests, formatting, zero-warning lint, strict TypeScript, the
production build, and Apple doctor `READY` with 20 migrations.

The corrective checkpoint passed formatting, zero-warning lint, strict TypeScript, 417 unit
tests, 33 focused pilot-command tests, 8 focused Apple database tests, 93 canonical aggregate
integration tests on the isolated Apple test database, the production build, 23 mock-only
Playwright tests, migration drift checks, and Apple doctor `READY` with 20 migrations.

The embedded-pagination corrective checkpoint passed 425 unit tests, 80 focused Apple tests, 9
Apple PostgreSQL tests, 94 aggregate integration tests, formatting, zero-warning lint, strict
TypeScript, the production build, 23 mock-only Playwright tests, migration drift checks, and Apple
doctor `READY` with 20 migrations.

## Live authentication evidence

One separately authorized public-catalog artist lookup returned HTTP 200, showing that Apple
accepted the developer credential. Resource URL metadata then failed the existing safe-URL
validation before artist identity confirmation. The controller stopped `failed/unsafe_url` after
one request with zero retries. The canary and full phase did not start.

The run used the canary-only 75-request and 15-minute database limits. The lease was released,
there is no cooldown, and Apple remains persistently disabled. A single parsed-response cache row
created before normalization failed was removed after the audit. Sanitized request telemetry and
the terminal run record remain. No raw response remains.

The retained telemetry cannot recover the rejected value or exact field. The throwing code path
rules out artist `attributes.url`. The failure category was response navigation metadata handled
by `assertAllowedAppleMusicPath` and `assertAllowedAppleMusicUrl`, with
`data[].relationships.albums.href` the strongest exact-path match. Credential-free injected HTTP
tests now complete the same response shape successfully, discard descriptive and non-followed URL
metadata, and cache only after normalization. Unsafe pagination produces zero cache rows,
sanitized telemetry, a released lease, and no subsequent request.

A separately authorized retry then made one BUNT. artist lookup. HTTP 200 again confirmed
developer-token acceptance. The non-followed `href` correction worked, but normalization stopped
on the exact request-capable field `relationships.albums.next`. Sanitized telemetry classified it
as relative HTTPS pagination on the allowed Apple API host with an `outside_allowlist` rejection.
No URL value or response body was retained.

The retry ended `failed/unsafe_url` after one request and 201 ms. BUNT. identity comparison did not
run, and the five-artist canary did not start. Searches, direct views, followed pagination, album
details, tracks, retries, and cache hits were all zero. Cache ordering succeeded live with zero
cache, mapping, album, song, and comparison rows. The lease was released, no cooldown was created,
and the real Apple request-event total is two. No source change was made after the live request.

Credential-free reconstruction confirmed the runner never follows the embedded albums
relationship because it retrieves the six approved views explicitly. Artist normalization no
longer treats embedded `href` or `next` metadata as executable. Explicit artist-view and
album-track pagination is now bound to the owning operation, route family, storefront, resource
identity, and view. Synthetic HTTP 200 identity normalization and sanitized cache persistence
pass, while unsafe cursor substitution creates zero cache or result rows and releases the lease.
No live request occurred during this correction.

See `docs/apple-music-api-canary-evaluation.md`.

## Credential and provider boundaries

- Local credentials remain in the ignored runtime file.
- The private key remains outside every repository.
- Credential identifiers and secret material, including Team ID, Key ID, Media ID, developer
  tokens, authorization values, private-key paths, key contents, and signatures, must never appear
  in source control, logs, telemetry, reports, or terminal output.
- Public Apple catalog artist, album, and song IDs are non-secret operational values. They may
  exist in the tracked pilot manifest, isolated Apple database, process memory, and local plan
  output. They remain excluded from committed evaluation reports, long-retained application logs,
  and sanitized request telemetry unless represented by a deterministic hash or fixed
  placeholder.
- Public catalog IDs are not equivalent to credential identifiers, tokens, authorization values,
  or key material.
- No additional live Apple request is authorized by this checkpoint.
- No Spotify, iTunes, or other-provider request occurred.
- Music User Tokens, personal libraries, playback, playlists, Apple Music Feed, artwork and
  preview handling, production integration, and merge into `codex/release-radar-hardening` remain
  prohibited.

See `docs/apple-music-api-design.md`, `docs/apple-music-pilot-handoff.md`,
`docs/apple-music-pilot-authorization.md`, `docs/apple-music-runtime.md`, and
`docs/provider-capabilities.md`.

## Historical retry and probe record

The operation-scoped live retry started from
`12ec1a4910fea9557549b13c6a3c358720306284`. BUNT. returned HTTP 200, normalized successfully,
discarded embedded navigation before normalized caching, and was identity-confirmed. Neither
prior `unsafe_url` failure recurred.

The run mapped 1991 and Alok as ambiguous and NURKO as search-confirmed. NURKO's first explicit
`latest-release` view returned HTTP 400, so the runner stopped `failed/http_error` without a
source change. G-Space, BUNT.'s six-view catalog pass, and every remaining cohort artist were not
reached. The run made five starts: one artist lookup, three searches, and one artist-view request.
It recorded four HTTP 200 responses and one HTTP 400 response, no retries or pagination, a
1,109 ms minimum interval, concurrency one, and a 4,609 ms duration.

The lease is released, cooldown is inactive, Apple remains disabled, and four valid normalized
cache rows remain. They contain no embedded navigation, artwork, previews, authorization data,
token data, or evidence URLs. No album, song, or comparison result was persisted. No other
provider or production state was touched.

The credential-free artist-view contract audit found that the failed request had the correct
method, host, storefront, route, artist placement, and view spelling but appended `limit=100` and
`with=attributes`. Both keys are documented as optional, and Apple explicitly permits
`with=attributes`; the retained prior evidence cannot prove which optional parameter or value
caused HTTP 400. All six normal artist-view first pages now use the documented minimal request
with no query parameters.

The direct-view parser accepts the official top-level `data` collection and optional top-level
`next`. The one-page diagnostic parser retains only a cursor-presence boolean and cannot follow or
persist the cursor. Apple HTTP errors now retain bounded safe status, code, title category,
parameter name, pointer classification, detail presence, endpoint, view, and query-key evidence.
Occurrence IDs, raw titles and details, pointer values, paths, URLs, query values, identifiers,
headers, tokens, and bodies are discarded. HTTP 400 is not retried and creates no cache or result
row.

The exact NURKO `latest-release` probe mode reads the existing confirmed mapping, has a
one-request budget and zero retries, cannot search, cannot request BUNT. or another artist, and
cannot follow pagination. Future request identities are hashed and contain no request path or
catalog identifier. No schema change was required.

The next authorized action, only after a clean committed and pushed verification checkpoint, is
one NURKO `latest-release` request through this probe mode. The five-artist canary, complete
25-artist cohort, representative cohort, production integration, and merge remain unauthorized.

## Live artist-view probe result

The source and test checkpoint was committed and pushed before live execution. The diagnostic
then made exactly one Apple request using the existing confirmed NURKO mapping:

`GET /v1/catalog/us/artists/<artist_id>/view/latest-release`

It used no optional query parameters, retries, searches, other artists, or pagination. Apple
returned HTTP 200. The official direct-view response shape parsed successfully with one resource
in the top-level `data` collection and no top-level `next` cursor.

The real Apple request-event count increased from seven to eight. The run completed with
`view_probe_completed`; one sanitized normalized probe cache row was created, while no mapping,
album, song, or comparison row was created. The lease is released, no cooldown is active, the
queue is empty, and Apple remains persistently disabled.

The prior HTTP 400 request used the same documented route but added the optional `limit` and
`with` query keys. The new minimal first-page builder removed both. Because the earlier raw error
was intentionally discarded, retained evidence cannot prove which parameter or value Apple
rejected.

No other artist, provider, runtime database, or production state was contacted or modified. No
credential, identifier, raw response, complete URL, header value, query value, or raw error was
recorded. The next recommended milestone is a separately authorized decision about the bounded
five-artist canary. No further live request, complete cohort, representative cohort, production
integration, merge, or scheduler activation is authorized.

## Next milestone

Perform a credential-free design and test update for a bounded comparison of Arm B with and
without `latest-release`, plus a targeted first-page remix-discovery correction for the known
MUST DIE! miss. Any subsequent live comparison requires separate authorization and a clean,
committed, pushed pre-live checkpoint.

The representative 25-artist sample, other 583 watchlist artists, production integration,
scheduling, playlists, Music User Tokens, personal libraries, playback, Apple Music Feed, and
merge remain unauthorized.
