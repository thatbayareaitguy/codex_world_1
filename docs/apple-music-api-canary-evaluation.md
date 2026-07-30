# Apple Music API Authentication and Canary Evaluation

Date: 2026-07-30

## Scope and checkpoint

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
- Relationship pagination allowlist complete: No
- Five-artist canary: Controlled failure before the canary started
- Full 25-artist cohort tested: No
- Representative cohort tested: No
- Production integration authorized: No
- Merged: No
