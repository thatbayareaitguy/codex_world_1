# Apple Music API Authentication and Canary Evaluation

Date: 2026-07-30

## Current canary state

- Branch: `codex/apple-music-discovery`
- Starting checkpoint: `414b9c260e0f080a90d44d66a28d77ba80b823da`
- Pre-live identifier-policy checkpoint: `ebb153ad23c71c1855652126ca28fc38e37d9f34`
- Storefront: US public catalog
- Starting real-request baseline: 8
- Current real-request total: 22
- Persistent provider state: `APPLE_MUSIC_ENABLED=false`
- Terminal result: `failed/not_found`, a controlled nonretryable HTTP 404 stop
- Remaining 20 pilot artists: not contacted

The credential-free plan validated the approved snapshot hash, exactly 25 pilot artists, the
canary `1991`, `Alok`, `NURKO`, `G-Space`, and `BUNT.`, the 75-request and 15-minute canary limits,
concurrency one, and at least 1,100 milliseconds between request starts. Plan mode made zero
requests and zero database writes and did not access credentials or the private key. Public
catalog IDs in local plan output were treated as non-secret operational values and were not copied
into this report or sanitized telemetry.

The committed request builder used minimal query-free first-page requests for all six artist
views. The live command authenticated BUNT., searched for 1991, Alok, and NURKO, and began NURKO's
views. It stopped when NURKO `live-albums` returned HTTP 404. G-Space and BUNT.'s catalog loop were
not reached.

## Current mapping and catalog evidence

| Artist  | Mapping result          | Catalog result                                                         |
| ------- | ----------------------- | ---------------------------------------------------------------------- |
| 1991    | `ambiguous`             | No views requested                                                     |
| Alok    | `ambiguous`             | No views requested                                                     |
| NURKO   | `search_confirmed`      | Three views succeeded; `live-albums` returned HTTP 404                 |
| G-Space | Not reached             | Not requested                                                          |
| BUNT.   | `existing_id_confirmed` | Authentication identity confirmed; canary catalog loop was not reached |

NURKO view evidence:

| View                 | Result                                                     |
| -------------------- | ---------------------------------------------------------- |
| `latest-release`     | HTTP 200, 1 resource, terminal first page                  |
| `singles`            | HTTP 200, 66 resources over 7 pages, 6 pagination requests |
| `full-albums`        | HTTP 200, 5 resources, terminal first page                 |
| `live-albums`        | HTTP 404 `not_found`, no retry                             |
| `compilation-albums` | Not reached                                                |
| `appears-on-albums`  | Not reached                                                |

The HTTP 404 retained only sanitized classification: status, fixed `not_found` title category,
machine-readable error code, detail-presence flag, `live-albums` view, and no query keys. No raw
detail, occurrence ID, catalog identifier, URL, header, token, or body was retained.

The run made 14 starts: one artist lookup, three artist searches, four first-page artist-view
requests, and six operation-owned pagination requests. It received 13 HTTP 200 responses and one
HTTP 404, with zero album-detail requests, track requests, retries, or cache hits. Minimum measured
pacing was 1,107 milliseconds, maximum concurrency was one, and persisted runtime was 14,931
milliseconds. Thirteen new sanitized cache rows were created, bringing the historical total to 18. The failed six-view collection created no album, song, or comparison row.

No prior cache or mapping row was reused by the current run. The earlier one-request NURKO probe
uses a deliberately separate cache identity, so `latest-release` was requested again. No network
request was demonstrably avoided by prior evidence.

## Current recall and forecast

No artist completed all six views and no comparison row was produced. Recall is therefore
unavailable for the 7-day, 14-day, 30-day, and 60-day windows and for singles, EPs, albums,
remixes, live releases, compilations, and credited appearances.

The frozen free-iTunes canary baseline remains 1991 at 0 of 1, Alok at 0 of 3, NURKO at 3 of 4,
G-Space at 2 of 4, and BUNT. at 4 of 4, for 9 of 16 combined. Apple recall cannot be compared
against that baseline from this incomplete run.

Mapping uncertainty consists of 1991 and Alok remaining ambiguous and G-Space remaining untested.
NURKO's `live-albums` HTTP 404 is a view-level controlled failure, not evidence of a ground-truth
release miss. No genuine Apple catalog miss, matcher-caused miss, ambiguous release match, or
Apple-only candidate can be classified.

The previous 217-of-225 forecast allowed six pagination requests for the entire canary and twelve
for the full 25-artist pilot. This partial run consumed six pagination requests on NURKO
`singles` alone, before completing even one artist. The previous forecast is therefore not
supported. The incomplete canary does not provide a defensible revised expected total or safe
full-run ceiling. A complete 25-artist pilot is not justified.

This five-artist controlled failure is not representative of the complete watchlist.

The next milestone should audit HTTP 404 semantics for an unavailable artist relationship view
credential-free, add synthetic coverage if a correction is needed, and request separate bounded
authorization before any live retry. No additional live request is authorized here.

## Historical milestone record

The remaining sections preserve the earlier authentication, URL-safety, pagination, HTTP 400,
and one-request diagnostic milestones in chronological form.

## Initial scope and checkpoint

- Branch: `codex/apple-music-discovery`
- Pre-live implementation checkpoint: `7577cca49ad946acfee1fb2e1a480419b97f0191`
- Corrected retry checkpoint: `40a985e3cb6d58f024ae291f6684a4a43a1f4803`
- Storefront: US
- Authorized scope: one public-catalog authentication probe followed by the five-artist canary
  only if authentication and identity validation completed safely
- Persistent provider state: `APPLE_MUSIC_ENABLED=false`

The live command used the existing bounded pilot runner with `--stop-after-canary`. The database
run was limited to 75 request starts, 15 minutes, concurrency one, and at least 1,100 milliseconds
between request starts. The full-phase client was not created.

## Pre-live verification

- Worktree, branch, HEAD, upstream, clean status, `0/0` divergence, and absent index lock passed.
- Apple doctor reported `READY` with 20 migrations applied.
- The ignored runtime file remained untracked and Apple Music remained persistently disabled.
- The private key existed outside every repository, and no repository contained a `.p8` file.
- The Apple development and test databases were healthy and isolated.
- No Apple lease, cooldown, incomplete run, request event, cache row, mapping, catalog row,
  comparison, or imported snapshot existed before execution.
- The main and iTunes worktrees were clean at pre-live verification and were not modified by this
  Apple task.

The credential-free plan validated snapshot SHA-256
`48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a`, exactly 25
artists, and the canary `1991`, `Alok`, `NURKO`, `G-Space`, and `BUNT.`. Plan mode made zero
requests and zero database writes without credential, key, or database access.

## Pre-live canary-only change

`--stop-after-canary` was added because the prior command always continued into the full cohort.
Credential-free tests prove that this option:

- uses the existing runner;
- binds the database run to 75 requests and 15 minutes;
- never creates the full-phase client;
- never invokes the full-cohort batch;
- records `canary_completed` only after a successful canary;
- releases the Apple lease; and
- preserves the cooldown.

Pre-live verification passed formatting, zero-warning lint, strict TypeScript, 410 unit tests, 33
focused pilot tests, 7 Apple database integration tests, 92 canonical aggregate integration tests
against the isolated Apple test database, the production build, Apple doctor, and
`git diff --check`.

## Authentication result

| Measurement                            | Result                                                      |
| -------------------------------------- | ----------------------------------------------------------- |
| HTTP status                            | 200                                                         |
| Authentication attempts                | 1                                                           |
| Developer credential accepted by Apple | Yes, based on HTTP 200                                      |
| Artist resource returned               | Yes, response schema parsing reached resource normalization |
| Returned identity matched              | Not evaluated                                               |
| Terminal result                        | `failed`                                                    |
| Stop reason                            | `unsafe_url`                                                |

The response passed HTTP and schema checks, but request-like URL metadata in the returned resource
failed `assertAllowedAppleMusicPath` and then `assertAllowedAppleMusicUrl` during normalization.
The retained sanitized evidence does not include the rejected value or exact field path. The code
path rules out artist `attributes.url`, which was handled by a non-throwing descriptive URL
function. The triggering category was resource or relationship navigation metadata. The strongest
exact-path match is `data[].relationships.albums.href`, a relationship link that the client did
not follow. The controller stopped immediately. It did not regenerate a token, retry
authentication, or change source.

The command summary's conservative `authentication.accepted=false` means the complete
authentication and identity phase did not finish. It does not contradict the HTTP 200 evidence
that Apple accepted the developer credential.

## Five-artist canary

The canary did not start because safe identity validation did not complete.

| Artist  | Mapping result | Six views     |
| ------- | -------------- | ------------- |
| 1991    | Not attempted  | Not requested |
| Alok    | Not attempted  | Not requested |
| NURKO   | Not attempted  | Not requested |
| G-Space | Not attempted  | Not requested |
| BUNT.   | Not confirmed  | Not requested |

No remaining cohort artist was contacted. No mapping can be classified as existing-ID confirmed,
search-confirmed, evidence-confirmed, ambiguous, no-match, or rejected because mapping evaluation
did not run.

## Catalog, pagination, and recall

All six direct views had zero requests and zero returned resources:

- `latest-release`
- `singles`
- `full-albums`
- `live-albums`
- `compilation-albums`
- `appears-on-albums`

Pagination requests were zero. Terminal pagination, relevant-release counts, and release recall
could not be measured.

Recall for 7-day, 14-day, 30-day, and 60-day windows is not available. Recall by singles, EPs,
albums, remixes, compilations, and credited appearances is also not available. There is no
evidence to classify mapping-caused misses, Apple catalog misses, matcher-caused misses, ambiguous
matches, or potential Apple-only releases.

## Request behavior

| Measurement                             | Result                          |
| --------------------------------------- | ------------------------------- |
| Total Apple HTTP starts                 | 1                               |
| Artist ID lookups                       | 1                               |
| Artist searches                         | 0                               |
| Direct-view requests                    | 0                               |
| Pagination requests                     | 0                               |
| Album-detail requests                   | 0                               |
| Track requests                          | 0                               |
| Retries                                 | 0                               |
| Cache hits                              | 0                               |
| HTTP errors                             | 0                               |
| Client safety-validation failures       | 1 (`unsafe_url`)                |
| Maximum measured concurrency            | 1                               |
| Minimum measured request-start interval | Not applicable with one request |
| Persisted run duration                  | 206 ms                          |
| Cooldown                                | Inactive                        |

The event recorded HTTP 200 and sanitized byte-count telemetry. No Music User Token, personal
library, playback, playlist, Feed, artwork, or preview request occurred.

## Response-cache correction

The HTTP 200 response was placed in the existing Apple response-cache table before resource
normalization raised `unsafe_url`. The post-run audit found that single parsed-response cache row.
It was removed by joining it to this run's request event. The sanitized request event and run
result were preserved.

No Apple response-cache row remains. No raw response, token, authorization header, credential
identifier, or private-key path remains in the database, documentation, logs reviewed for this
milestone, or source control.

The credential-free correction changes the lifecycle so a response is cached only after bounded
body reading, JSON parsing, schema validation, strict validation of request-capable URLs, complete
normalization, and removal of descriptive or unused URL metadata. Non-followed relationship
`href` values and Apple sharing URLs are discarded. They never become transport targets.

Synthetic tests now prove:

- a representative HTTP 200 artist response with relative API `href`, descriptive sharing `url`,
  and non-followed albums relationship `href` normalizes successfully;
- identity is available for comparison and one sanitized cache entry is created only after
  success;
- valid same-host pagination is normalized to a relative catalog path;
- cross-host, non-catalog, and `/v1/me` pagination return `unsafe_url`, create zero cache rows,
  release leases, retain only fixed-category telemetry, and make no subsequent request;
- schema and normalization failures create zero cache rows; and
- repeated pagination remains rejected before a third request.

The real Apple request-event count remained one before and after this correction. No live Apple
or other-provider request occurred.

## 2026-07-30 bounded retry

The separately authorized retry used the corrected checkpoint and the existing canary-only
command. Pre-live checks confirmed the exact worktree, branch, HEAD, synchronized upstream, clean
status, absent index lock, Apple doctor `READY`, 20 migrations, ignored and untracked runtime,
`APPLE_MUSIC_ENABLED=false`, external private key, zero repository `.p8` files, no active lease,
no cooldown, no incomplete run, and exactly one prior real Apple request event.

Formatting, zero-warning lint, strict TypeScript, and 71 focused Apple tests passed before live
access. The file-only plan validated the pinned snapshot hash, exactly 25 artists, the canary
`1991`, `Alok`, `NURKO`, `G-Space`, and `BUNT.`, a 55-of-75 canary forecast, zero requests, and
zero database writes.

One BUNT. public-catalog artist lookup returned HTTP 200. Developer-token acceptance was therefore
confirmed again, but normalization stopped before identity comparison. The corrected handling
successfully avoided the prior non-followed `href` category. The new sanitized diagnostic
identified the exact field as `relationships.albums.next`, with role `pagination`, relative form,
HTTPS, allowed Apple API host, and rejection reason `outside_allowlist`. No URL value, query,
artist identifier, response body, token, key path, or authorization header was recorded.

The `next` value was request-capable pagination metadata, so the client did not discard or follow
it. It stopped safely because the current catalog path allowlist did not recognize that
relationship-pagination path. Source was not changed after the live request.

| Measurement                            | Retry result                    |
| -------------------------------------- | ------------------------------- |
| HTTP status                            | 200                             |
| Authentication attempts                | 1                               |
| Developer credential accepted by Apple | Yes, based on HTTP 200          |
| BUNT. normalization completed          | No                              |
| BUNT. identity matched                 | No, not evaluated               |
| Terminal result                        | `failed/unsafe_url`             |
| New Apple HTTP starts                  | 1                               |
| Artist ID lookups                      | 1                               |
| Searches                               | 0                               |
| Direct-view requests                   | 0                               |
| Pagination requests followed           | 0                               |
| Album-detail requests                  | 0                               |
| Track requests                         | 0                               |
| Retries                                | 0                               |
| Cache hits                             | 0                               |
| Maximum concurrency                    | 1                               |
| Minimum request-start interval         | Not applicable with one request |
| Persisted run duration                 | 201 ms                          |
| HTTP 429 responses                     | 0                               |
| Cooldown                               | Inactive                        |

The five-artist canary did not start. Mapping outcomes were not attempted for `1991`, `Alok`,
`NURKO`, or `G-Space`; BUNT. was not confirmed because normalization stopped before identity
comparison. All six direct views had zero requests, resources, pagination pages, terminal
pagination results, and relevant releases. Recall by 7, 14, 30, and 60 days and by singles, EPs,
albums, remixes, compilations, and credited appearances remains unavailable. Mapping-caused,
catalog-caused, matcher-caused, ambiguous, and Apple-only outcomes cannot be classified.

Cache ordering behaved correctly during the real retry. The HTTP 200 validation failure created
zero cache, mapping, album, song, and comparison rows. The terminal sanitized request event and
failed run record were preserved. The lease was released, no cooldown was created, and no
subsequent request occurred. The real Apple request-event baseline increased only from one to two.
No remaining cohort artist or other provider was contacted.

## Credential-free embedded-pagination correction

Code-path reconstruction confirmed that `relationships.albums.next` was classified as executable
only because artist normalization validated every relationship `next`. The pilot does not follow
the embedded albums relationship. It obtains catalog evidence through the six explicit artist
views, and album tracks through the explicit album-track operation.

The correction makes URL handling execution-driven. Embedded artist, album, song, view, search,
and unknown relationship navigation is discarded. Only the explicit artist-view and album-track
loops retain pagination. Their cursors are validated against the owning operation, exact route
family, US storefront, originating resource identity, and originating artist view. Query keys are
operation-specific, duplicate detection uses canonical query ordering, and redirects are blocked.

Credential-free reproduction now proves:

- an HTTP 200 artist response with embedded albums `href` and `next` normalizes to usable identity;
- unknown embedded relationships and fields named `next` remain inert;
- embedded navigation does not reach transport or sanitized cache persistence;
- one sanitized cache row is created only after complete normalization;
- direct artist-view and album-track pagination is followed;
- cross-operation, cross-identity, wrong-storefront, cross-host, `/v1/me`, library,
  unsupported-resource, unsupported-query, and duplicate pagination stops before another request;
- unsafe pagination creates zero cache or result rows, retains sanitized terminal evidence, and
  releases the lease.

Verification passed formatting, zero-warning lint, strict TypeScript, 425 unit tests, 80 focused
Apple tests, 9 Apple PostgreSQL tests, 94 canonical aggregate integration tests, the production
build, 23 mock-only Playwright tests, migration drift checks, Apple doctor, and
`git diff --check`. All HTTP responses were injected. The real Apple request count remained two.

## Full-run projection

- Prior planning forecast: 217 of 225 requests.
- Revised measured forecast: still unavailable because the five-artist canary did not run.
- Expected pagination, searches, album-detail calls, track calls, and retry allowance cannot be
  recalculated from one authentication lookup.
- A 225-request full-run ceiling is not supported by measured canary evidence.
- A recommended minimum safe ceiling cannot be established until a successful bounded canary
  produces representative measurements.

A complete 25-artist test is not justified from this evidence.

## Final safety evidence

- The run ended `failed/unsafe_url`; no run remains active.
- The Apple lease was released and no cooldown is active.
- Apple remains persistently disabled.
- No mapping, album, song, comparison, artwork, preview, or raw response remains persisted.
- The immutable comparison snapshot was imported into the isolated Apple database only.
- Apple-scoped production tables and every non-Apple request-event table remain empty.
- Spotify, free iTunes, MusicBrainz, SoundCloud, Reddit, and all other providers were not
  contacted.
- The main and iTunes worktrees and their runtime databases were not modified by this Apple task.
  At the final audit, unrelated uncommitted iTunes manifest and source/test changes had appeared
  concurrently. They were left untouched.
- No production feed, scanner, scheduler, playlist, or UI state was mutated.

## Evidence classification

- Provider implemented: Yes
- Pilot runner implemented: Yes
- Plan mode executed: Yes
- Authentication accepted: Yes, HTTP 200 on both bounded attempts
- Non-followed URL category corrected credential-free: Yes
- Embedded relationship pagination corrected credential-free: Yes
- Executable pagination operation-scoped: Yes
- Five-artist canary: Controlled failure before the canary started
- Full 25-artist cohort tested: No
- Representative cohort tested: No
- Production integration authorized: No
- Merged: No

## 2026-07-30 operation-scoped pagination retry

The separately authorized retry started from
`12ec1a4910fea9557549b13c6a3c358720306284`. The worktree was clean and synchronized, the
index lock was absent, Apple doctor was `READY` with 20 migrations, the real Apple request-event
baseline was exactly two, and there was no active run, lease, cooldown, cache, mapping, catalog,
or comparison state. The ignored runtime remained untracked with `APPLE_MUSIC_ENABLED=false`.
The private key remained outside all repositories, and no repository contained a `.p8` file.

The credential-free plan validated the required snapshot hash, selected exactly 25 pilot artists
from the 50-artist source snapshot, selected the exact canary `1991`, `Alok`, `NURKO`, `G-Space`,
and `BUNT.`, used the US storefront, and forecast 55 of 75 canary requests within 15 minutes.
Plan mode made zero requests and zero database writes. Formatting, zero-warning lint, strict
TypeScript, 72 focused provider, command, and isolation tests, and 9 Apple database tests passed
before live execution.

Two command launches were rejected by local safety guards before token generation, database
writes, or network access. The first found non-Apple provider defaults in the process environment.
The second found no database URL. The successful launch used temporary process-only overrides to
disable every non-Apple provider and select the isolated loopback Apple database. No runtime file
was changed.

### Authentication and BUNT. result

The BUNT. public-catalog artist lookup returned HTTP 200. Parsing and normalization completed,
embedded relationship navigation remained inert, identity evidence produced
`existing_id_confirmed`, and the normalized artist response entered the cache. Neither prior
`unsafe_url` failure recurred. The normalized cache contains no `href`, `next`, artwork, preview,
authorization, bearer, or evidence-URL data.

The authentication lookup was made once. The run stopped before reaching BUNT. in the canary
catalog loop, so there was no duplicate BUNT. lookup, but catalog-loop reuse was not exercised.

### Canary result

The run ended `failed/http_error` after the first explicit artist-view request returned HTTP 400.
The failing operation was NURKO `latest-release`, the first view in the fixed six-view sequence.
The sanitized evidence does not retain a response body, complete URL, query value, or provider
identifier, so the cause cannot be narrowed beyond an incompatibility in that explicit view
request. The milestone prohibits a source correction, and no source or schema change was made.

| Artist  | Mapping result          | Six-view result                                                     |
| ------- | ----------------------- | ------------------------------------------------------------------- |
| 1991    | `ambiguous`             | Not requested because no artist identity was confirmed              |
| Alok    | `ambiguous`             | Not requested because no artist identity was confirmed              |
| NURKO   | `search_confirmed`      | `latest-release` returned HTTP 400; the other five were not started |
| G-Space | Not reached             | Not requested                                                       |
| BUNT.   | `existing_id_confirmed` | Not reached after the earlier NURKO stop                            |

Exactly four canary names were contacted: BUNT., 1991, Alok, and NURKO. G-Space was not
contacted, and none of the remaining 20 cohort artists was contacted.

No pagination cursor was followed. The initial `latest-release` request did not reach a terminal
pagination state, so live operation-owned pagination could not be evaluated. Album details and
album tracks were not requested. Credential-free coverage remains the evidence for rejecting
cross-host, cross-storefront, cross-identity, cross-view, unsupported-route, unsupported-query,
library, `/v1/me`, redirect, and duplicate-page navigation.

### Request evidence

| Measurement                             | Result           |
| --------------------------------------- | ---------------- |
| New Apple HTTP starts                   | 5                |
| Historical Apple request-event total    | 7                |
| HTTP statuses                           | 4 x 200; 1 x 400 |
| Artist ID lookups                       | 1                |
| Artist searches                         | 3                |
| `latest-release` requests               | 1                |
| Other direct-view requests              | 0                |
| Pagination requests                     | 0                |
| Album-detail requests                   | 0                |
| Album-track requests                    | 0                |
| Retries                                 | 0                |
| Request-time cache hits                 | 0                |
| New normalized cache entries            | 4                |
| Minimum measured request-start interval | 1,109 ms         |
| Maximum concurrency                     | 1                |
| Persisted run duration                  | 4,609 ms         |
| Client validation failures              | 0                |
| HTTP errors                             | 1                |
| Cooldown                                | Inactive         |

The six-view request breakdown is therefore one `latest-release` request and zero requests for
`singles`, `full-albums`, `live-albums`, `compilation-albums`, and `appears-on-albums`.
Pagination by owning operation is zero for artist views and zero for album tracks. Embedded
navigation was discarded without transport or cache persistence.

### Recall and forecast

No artist completed all six views, so release recall is unavailable for the 7-day, 14-day,
30-day, and 60-day windows and for singles, EPs, albums, remixes, live releases, compilations,
and credited appearances. No album, song, or comparison row was created.

The ambiguous 1991 and Alok mappings block evaluation of 4 of the frozen canary's 16 releases.
The explicit-view HTTP failure prevented catalog and matcher evaluation for the other 12.
Therefore no Apple catalog miss, matcher-caused miss, ambiguous release match, or Apple-only
candidate can be classified from this run.

Measured behavior is insufficient to revise the full-pilot forecast. The run observed three
searches, one of the planned 30 canary base-view requests, zero pagination, zero album-detail or
track requests, and zero retries before stopping. The prior synthetic forecast of 217 of 225
requests remains unvalidated. A safe full-run request ceiling and runtime cannot be established,
and 225 requests is not justified as sufficient. A complete 25-artist run is not justified until
the explicit-view incompatibility is corrected credential-free and the bounded five-artist
canary completes.

### Final safety evidence

- The terminal run is `failed/http_error`; no run or lease remains active.
- Apple remains persistently disabled, with no cooldown and an empty queue.
- Four normalized cache entries remain as valid live evidence. They contain no embedded
  navigation, artwork, previews, authorization data, token data, or evidence URLs.
- No raw response, complete response or pagination URL, credential, authorization header,
  private-key path, or provider identifier was recorded in this report.
- No Music User Token, personal library, playback, playlist, Feed, production scanner,
  scheduler, feed, artwork, or preview operation occurred.
- No other provider was contacted, and no production state was mutated.
- The main worktree remained clean. The iTunes worktree's pre-existing manifest and three
  source-file changes were left untouched.
- Apple doctor remained `READY`, the focused 9-test Apple database suite passed, and
  `git diff --check` passed before checkpointing.

Updated evidence classification:

- Provider implemented: Yes
- Pilot runner implemented: Yes
- Plan mode executed: Yes
- Authentication accepted: Yes, HTTP 200
- BUNT. normalization and identity confirmation: Yes
- Five-artist canary: Failed safely before completion
- Full 25-artist cohort tested: No
- Representative cohort tested: No
- Production integration authorized: No
- Merged: No

## 2026-07-30 one-request artist-view probe

The post-checkpoint diagnostic made one live Apple request and stopped. Its sanitized request
shape was:

- Method: `GET`
- Host classification: allowed Apple Music API host
- Path template: `/v1/catalog/us/artists/<artist_id>/view/latest-release`
- Storefront: `us`
- View: `latest-release`
- Query-key names: none

The earlier failed request used the same method, host classification, storefront, artist
placement, `/view/` route, and view spelling, but added the optional `limit` and `with` query
keys. The diagnostic removed both optional parameters. The retained evidence from the earlier
HTTP 400 does not establish which parameter or value Apple rejected.

The minimal request returned HTTP 200. The direct-view response parsed successfully from its
top-level `data` collection and returned one resource. No top-level `next` cursor was present,
and pagination was not followed. No sanitized Apple error code, title category, or source
parameter was produced because the request succeeded.

The real Apple request-event count increased from seven to eight. The probe used the already
confirmed NURKO mapping, performed no search, contacted no other artist or provider, and made no
production mutation. One sanitized normalized probe cache row was created. It contains one
resource and no cursor, artwork, previews, navigation, URL, credential, header, token, or raw
response. The probe created no mapping, album, song, or comparison row. Its run completed with
`view_probe_completed`; the lease was released, no cooldown was created, and Apple remains
persistently disabled.

Recommended next milestone: decide whether to authorize a newly bounded five-artist canary based
on the successful direct-view probe. The canary, complete cohort, representative cohort,
production integration, merge, and any additional live request remain unauthorized.

Post-probe evidence classification:

- Authentication accepted: Yes
- Artist lookup proven: Yes
- Artist search proven: Yes
- Artist mapping partially tested: Yes
- Direct artist-view probe: Passed
- Five-artist canary completed: No
- Full cohort tested: No
- Representative cohort tested: No
- Production integration authorized: No
- Merged: No
