# Apple Music Recent-Release Discovery Strategy Analysis

Date: 2026-07-30

## Scope and conclusion

This is a credential-free analysis of the 22 existing Apple HTTP starts, normalized response
cache, isolated Apple database, frozen comparison snapshot, current implementation, and current
official Apple Music API documentation. It made no Apple Music API or other-provider request.

Release Radar should not paginate all six artist views to exhaustion every week. The evidence
supports a hybrid model: shallow fresh discovery on a weekly cadence, targeted album or track
inspection for recent candidates, and a separately budgeted deeper reconciliation on a slower
cadence. This is a design recommendation, not production authorization.

The reason is twofold:

1. NURKO's 66 cached `singles` resources were strictly newest-to-oldest, and every Apple resource
   inside the frozen 14, 30, and 60-day windows was already on page one.
2. Page-one depth was not the only recall problem. Two frozen NURKO releases were absent as the
   same release from the available `latest-release`, `singles`, and `full-albums` evidence.
   Additional historical `singles` pages could not recover them. Endpoint coverage, particularly
   appearances, therefore matters more than exhaustive history for this example.

Apple does not document artist-view release-date ordering. NURKO alone cannot establish a safe
date-based stopping rule for the watchlist.

## Evidence boundaries

Measured evidence in this document means a result calculated from the existing normalized cache,
request telemetry, or frozen snapshot. Documented behavior means an option stated in current
official Apple documentation. Assumptions and proposed budgets are labeled separately.

The frozen snapshot date is 2026-07-29. Inclusive date-window starts are:

| Window  | Start      |
| ------- | ---------- |
| 7 days  | 2026-07-23 |
| 14 days | 2026-07-16 |
| 30 days | 2026-06-30 |
| 60 days | 2026-05-31 |

## Existing NURKO page evidence

### Page-by-page distribution

No resource identifiers are included.

| View             | Page | Resources | Earliest date  | Latest date    |  7d | 14d | 30d | 60d | Cross-page duplicates | Missing dates | Partial dates |
| ---------------- | ---: | --------: | -------------- | -------------- | --: | --: | --: | --: | --------------------: | ------------: | ------------: |
| `latest-release` |    1 |         1 | 2026-07-17     | 2026-07-17     |   0 |   1 |   1 |   1 |                     0 |             0 |             0 |
| `singles`        |    1 |        10 | 2025-02-14     | 2026-07-17     |   0 |   1 |   1 |   3 |                     0 |             0 |             0 |
| `singles`        |    2 |        10 | 2023-04-06     | 2024-09-13     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `singles`        |    3 |        10 | 2021-11-12     | 2023-03-03     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `singles`        |    4 |        10 | 2020-08-07     | 2021-08-13     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `singles`        |    5 |        10 | 2018-12-07     | 2020-07-24     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `singles`        |    6 |        10 | 2018-06-08     | 2018-11-21     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `singles`        |    7 |         6 | 2016-03-15     | 2018-05-22     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `full-albums`    |    1 |         5 | 2021-02-25     | 2025-09-30     |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |
| `live-albums`    |    1 |         0 | Not applicable | Not applicable |   0 |   0 |   0 |   0 |                     0 |             0 |             0 |

`live-albums` returned HTTP 404 and is historical `unavailable_404` evidence, not an empty
catalog response. No cache row exists for it.

### Ordering

The cached order was:

- `latest-release`: one dated resource.
- `singles`: strictly nonincreasing by release date within and across all seven pages.
- `full-albums`: strictly nonincreasing by release date on its only page.

There were zero out-of-order date transitions, zero duplicates, zero missing dates, and zero
partial dates. The last Apple page containing a resource inside the 14, 30, or 60-day window was
page one. There were no Apple resources in the 7-day window.

For NURKO, the first `singles` page already crossed well below the 60-day boundary. If Apple
guaranteed newest-to-oldest ordering, the remaining six pages could have been skipped for recent
discovery. Apple does not document that guarantee, so this is an observed optimization candidate,
not a safe general rule.

### Frozen release coverage

The frozen NURKO evidence contains four releases:

| Window membership   | Frozen release date | Existing available-view result                                                    |
| ------------------- | ------------------- | --------------------------------------------------------------------------------- |
| 14, 30, and 60 days | 2026-07-17          | Present on page one of `latest-release` and `singles`                             |
| 30 and 60 days      | 2026-07-10          | Not present as the same release in available cached views                         |
| 60 days             | 2026-06-26          | Present on page one of `singles`                                                  |
| 60 days             | 2026-06-05          | A different remix/version was present; it cannot be counted as the frozen release |

Consequences:

- 7-day: the frozen set contains no NURKO release, so page-one coverage is vacuously complete but
  provides no positive evidence.
- 14-day: the one frozen release was on page one.
- 30-day: one of two frozen releases was on page one; the other was absent.
- 60-day: two of four frozen releases were recognizable on page one; two were absent as the same
  release.
- No later `singles` page added a 14, 30, or 60-day resource.

This does not establish completed recall. `compilation-albums` and `appears-on-albums` were not
requested, and Apple describes `appears-on-albums` as a selection rather than a complete
relationship.

## Cache and incremental behavior

### Current implementation

The cache identity is a SHA-256 digest of:

- an operation scope;
- normalized request path, including storefront, route, resource identity, and view;
- sorted query keys and values, including pagination offsets.

The stored identity exposes only the scope-independent route category, initial-versus-pagination
classification, and digest. Successful normalized responses are stored. Errors, including the
view HTTP 404, are not cached.

There is no expiration column, time-to-live rule, freshness check, ETag support, Last-Modified
support, or conditional request. An exact identity remains a cache hit indefinitely until
explicitly replaced or deleted.

### Weekly implications

- Safe reuse: deterministic replay, comparison of immutable historical evidence, and avoiding
  repeat work when freshness is not required.
- Potentially stale reuse: every catalog discovery request. The current cache cannot prove that a
  previously successful page still represents the current catalog.
- Unknown behavior requiring measurement: how Apple offsets change when new resources are
  inserted and whether an unchanged later-page cursor remains semantically stable.

First pages and later pages have independent identities. This does not make incremental refresh
safe. A newly inserted release can shift offset-based pages. Refreshing page one while reusing
older cached offset pages can create a gap, overlap, or misaligned historical sequence.

Under the current implementation, a rerun of the same NURKO operations would use cache hits for
the successful normal-scope pages, including all seven `singles` pages. It would not refresh page
one. `live-albums` would remain a network miss because its HTTP 404 was not cached. The earlier
one-request diagnostic has a deliberately different scope and does not substitute for normal
pilot cache identity.

The current cache is therefore not a safe incremental discovery cache. It is a safe historical
evidence cache.

## Current official Apple options

Verified on 2026-07-30:

- [Direct artist relationship view](https://developer.apple.com/documentation/applemusicapi/fetch-a-view-on-this-resource-by-name-4kow5):
  `GET /v1/catalog/{storefront}/artists/{id}/view/{view}`. Documented query parameters are
  `extend`, `include`, `l`, `limit`, and `with`. No release-date filter is documented.
- [RelationshipViewResponse](https://developer.apple.com/documentation/applemusicapi/relationshipviewresponse):
  `data` is paginated and optional `next` is a relative cursor.
- [Artist views](https://developer.apple.com/documentation/applemusicapi/artists/views-data.dictionary):
  `latest-release` is the latest release Apple deems still recent. It is not documented as all
  recent releases. `appears-on-albums` is explicitly a selection.
- [Resource representation and relationships](https://developer.apple.com/documentation/applemusicapi/handling-resource-representation-and-relationships):
  `views` requests relationship views in a resource response. Apple provides a single-artist
  example. Included views can still require pagination.
- [Single catalog artist](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-artist):
  an individual artist resource can carry activated views.
- [Multiple catalog artists](https://developer.apple.com/documentation/applemusicapi/get-multiple-catalog-artists):
  the endpoint accepts up to 25 IDs, but its endpoint-specific query-parameter list contains
  `ids`, `l`, `include`, and `extend`, not `views`. Batch embedded views are therefore not
  documented and must not be assumed.
- [Artist albums relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5akdm):
  `GET /v1/catalog/{storefront}/artists/{id}/albums` is the generic associated-albums
  relationship.
- [Artist relationship limits](https://developer.apple.com/documentation/applemusicapi/artists/relationships-data.dictionary):
  artist albums have a default fetch limit of 25 and maximum of 100.
- [Fetching resources by page](https://developer.apple.com/documentation/applemusicapi/fetching_resources_by_page):
  Apple returns a relative `next` cursor with an offset when another page exists.
- [Album release dates](https://developer.apple.com/documentation/applemusicapi/albums/attributes-data.dictionary):
  release date may be a full date or only a year. The observed NURKO pages happened to contain
  full dates only.

Apple does not document artist-view ordering, a release-date filter for these operations, or
completeness for `appears-on-albums`. The direct-view endpoint documents `limit` but does not
state a default or maximum on that endpoint page. The observed direct-view page size was 10.

Apple Music Feed remains excluded and is not a recommended path.

## Strategy comparison

Request counts below cover discovery for already mapped artists. Mapping, retries, album details,
and track retrieval are additional. Runtime is the theoretical pacing floor at 1,100 ms per
request start and excludes network and processing time. A plus sign means the upper tail is not
bounded by current evidence.

| Strategy                                 |           Requests per mapped artist |  25 artists |     593 artists | Pacing floor for 25 | Pacing floor for 593 |
| ---------------------------------------- | -----------------------------------: | ----------: | --------------: | ------------------- | -------------------- |
| A. Six views, exhaustive                 |                             6 to 12+ | 150 to 300+ | 3,558 to 7,116+ | 2m45s to 5m30s+     | 65m14s to 130m28s+   |
| B. Six views, first page                 |                                    6 |         150 |           3,558 | 2m45s               | 65m14s               |
| C. Latest plus selected first pages      |                               5 to 6 |  125 to 150 |  2,965 to 3,558 | 2m18s to 2m45s      | 54m22s to 65m14s     |
| D. Hybrid weekly shallow                 |                        4 to 5 weekly |  100 to 125 |  2,372 to 2,965 | 1m50s to 2m18s      | 43m29s to 54m22s     |
| D. Hybrid reconciliation                 |                             6 to 12+ | 150 to 300+ | 3,558 to 7,116+ | 2m45s to 5m30s+     | 65m14s to 130m28s+   |
| E. Individual artist with embedded views | 1 first page; 1 to 7+ with follow-up |  25 to 175+ |   593 to 4,151+ | 28s to 3m13s+       | 10m52s to 76m6s+     |
| F. Generic albums relationship           |        1 first page; modeled 1 to 3+ |   25 to 75+ |   593 to 1,779+ | 28s to 1m23s+       | 10m52s to 32m37s+    |

### A. Exhaustive six-view scan

- Strength: maximal retrieval from the six supported views at scan time.
- Risks: high and unbounded pagination cost; `appears-on-albums` is still only a selection; stale
  cache reuse defeats freshness; unavailable views add incomplete coverage.
- Measured: NURKO required six extra `singles` pages, and those pages added no resource inside 60
  days.
- Unproven: pagination distribution across other artists and Apple ordering.
- Manual review: still required for remixes, versions, and appearance credit.

### B. Six-view first-page scan

- Strength: bounded and preserves all six view categories.
- Risks: can miss recent resources beyond page one because ordering is not documented.
- Measured: NURKO lost no Apple resource inside 60 days by omitting later pages.
- Unproven: whether that holds for another artist or a busy release week.
- Manual review: unchanged for ambiguous versions and credits.

### C. Latest-release plus selected first pages

- Weekly views: `latest-release`, `singles`, `full-albums`, `compilation-albums`, and
  `appears-on-albums`; probe `live-albums` during reconciliation or when evidence indicates it.
- Strength: one fewer regular request while preserving the view most likely to recover featured
  appearances.
- Risks: live releases can be delayed until reconciliation; `latest-release` is only one release;
  appears-on is a selection.
- Measured: NURKO `live-albums` was unavailable and added no usable evidence.
- Unproven: unavailable-view rate and category recall across the cohort.

### D. Hybrid cadence

- Weekly: shallow fresh discovery using four or five high-value operations.
- Monthly: six-view first pages and targeted pagination experiments.
- Quarterly or rotating: deeper reconciliation, bounded by observed cursor depth.
- Strength: separates freshness from historical completeness and limits weekly tail risk.
- Risks: reconciliation delay for omitted categories; requires explicit stale-cache policy.
- Measured: NURKO's historical pagination had zero additional recent-window resources.
- Unproven: the best reconciliation cadence for 593 artists.

### E. Embedded-view artist request

- Strength: potentially returns several first-page views in one individual artist request.
- Risks: embedded view sizes, omission behavior, error behavior, and cursors need live
  measurement; later view pages still require separate requests.
- Documented: `views` on a resource response and a single-artist example.
- Not documented: `views` on the multiple-catalog-artists endpoint.
- Manual review: same matching and version review as direct views.

### F. Generic albums relationship

- Strength: one official relationship, default 25 and maximum 100 resources, potentially covering
  self-associated singles and albums with fewer requests.
- Risks: it may omit releases primarily credited to another artist, remixes, and appearances; it
  does not provide the view classifications directly.
- Measured: no generic-albums request exists in current evidence.
- Assumption: a 1 to 3+ page model based on the documented 25-resource default and the observed
  size of NURKO's self-associated view results. This is not measured endpoint behavior.
- Manual review: appearance credit and version identity become more important.

## Pilot option budgets

These are analytical options only. None is authorized or executed.

All options use the same five artists: 1991, Alok, NURKO, G-Space, and BUNT.

| Option                     | Maximum requests | Runtime ceiling | Operations                                                                          | Pagination | Answers                                        | Cannot answer                           |
| -------------------------- | ---------------: | --------------- | ----------------------------------------------------------------------------------- | ---------- | ---------------------------------------------- | --------------------------------------- |
| Existing exhaustive canary |               90 | 20 minutes      | Mapping, six direct views, all valid cursors, targeted details/tracks               | Full       | Six-view recall and measured pagination        | Weekly efficiency under a shallow model |
| First-page-only canary     |               40 | 10 minutes      | Mapping plus six direct first pages                                                 | None       | Six-view first-page recall per request         | Historical completeness                 |
| Embedded-view probe        |               15 | 5 minutes       | Mapping plus one individual artist fetch with six requested views                   | None       | Embedded shape, omissions, first-page coverage | Batch support or deep completeness      |
| Generic-albums probe       |               15 | 5 minutes       | Mapping plus one artist albums relationship request at maximum documented page size | None       | Primary associated-release recall per request  | Appearance completeness                 |
| Two-strategy hybrid canary |               20 | 7 minutes       | Mapping, embedded views, and generic albums on the same artists                     | None       | Embedded versus generic recall and overlap     | Direct-view baseline or deep pagination |

Budgets include a small controlled reserve but do not change repository policy or authorize live
access.

## Recommended recurring operating model

Subject to a successful strategy-comparison experiment:

1. Treat mappings as durable identity evidence and refresh only under an explicit mapping policy.
2. Run fresh shallow discovery weekly. Do not satisfy freshness checks from the current
   nonexpiring cache.
3. Normalize and compare first-page candidates immediately.
4. Fetch album details and tracks only for recent candidates that need version, credit, or
   appearance proof.
5. Run a monthly six-view first-page reconciliation.
6. Run deeper pagination quarterly on a rotating subset, or when a validated cursor page still
   contains dates inside the reconciliation window.
7. Do not use a date-based early stop globally until ordering is measured across a broader cohort
   and guarded against out-of-order pages. Apple does not document the ordering.

## Exactly one recommended next live experiment

Recommend one five-artist, three-arm, first-page strategy comparison.

- Artists: 1991, Alok, NURKO, G-Space, and BUNT.
- Request ceiling: 50.
- Runtime ceiling: 12 minutes.
- Storefront: US.
- Mapping: use safely confirmed stored mappings where available; otherwise use the existing
  bounded lookup/search rules. Ambiguous mapping skips that artist's discovery arms and does not
  stop later artists.
- Arm 1: six direct artist-view first pages.
- Arm 2: one individual artist fetch requesting the same six embedded views.
- Arm 3: one generic artist albums relationship request using the documented maximum page size.
- Pagination: never follow `next` in any arm.
- Album details and tracks: none unless a separately predeclared comparison cannot distinguish a
  recent candidate without them; if allowed, they must remain inside the same ceiling.
- Existing cache: use it read-only as the historical comparison baseline. Do not treat stale
  cached pages as fresh arm results. Use experiment-specific cache identities for fresh requests
  and do not delete or rewrite historical rows.
- Required output: mapping outcome, per-arm request count, normalized resources, recent-window
  matches against all 16 frozen canary releases, duplicates between arms, omitted views,
  unavailable views, returned-cursor presence, recall per request, and sanitized failures.
- Stop conditions: request or runtime ceiling, HTTP 401 or 403, HTTP 429, unsafe URL or cursor,
  malformed response, persistent provider enabled, unexpected provider access, or inability to
  isolate fresh responses from historical cache.

This experiment directly compares strategies B, E, and F without paying for historical
pagination. It can identify the best first-page recall per request and show which release classes
need slower reconciliation. It cannot prove 593-artist behavior, ordering, or complete appearance
coverage.

## Evidence classification

- Authentication accepted: previously proven.
- Artist lookup and search: previously proven.
- NURKO direct-view first-page retrieval: proven.
- NURKO `singles` pagination: proven through seven pages.
- NURKO newest-to-oldest ordering: observed, not documented or generalized.
- First-page 14-day coverage for NURKO: observed.
- First-page 30-day and 60-day complete frozen recall: disproven by available evidence.
- Embedded artist views: documented for individual resources, not live-tested here.
- Multiple-artist embedded views: not documented.
- Generic albums relationship: documented, not live-tested here.
- Five-artist recall: not completed.
- Representative watchlist performance: not established.
- Production readiness and merge readiness: not established.
