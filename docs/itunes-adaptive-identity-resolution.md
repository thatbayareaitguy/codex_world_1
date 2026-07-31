# Adaptive Full-Watchlist iTunes Identity Resolution

Prepared: 2026-07-30

## Decision

The next separately authorized live test should evaluate the hybrid targeted-search plus adaptive
lookup method. This milestone does not authorize that test.

The reason is bounded and specific. Album-first alone reduces the projected request count, but it
cannot discover an Apple artist ID omitted from the first 10 artist-name results. Historical-title
search can address that truncation risk, while album-first lookup remains a deterministic fallback.
The hybrid design preserves ambiguity when neither stage provides enough evidence.

iTunes is not classified as primary, supplemental, rejected, or production-ready.

## Frozen inputs and isolation

- Full-watchlist census: 593 terminal artists.
- Census final file SHA-256:
  `ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa`
- Census canonical SHA-256:
  `8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d`
- Census behavior fingerprint:
  `1493cc6db2ae9e939ea6ae904f6a2625b760be96feef3a6820151126118cd4a4`
- Historical evidence cutoff: `2026-07-30T02:10:30.000Z`
- Historical evidence source: clean, synchronized
  `codex/release-radar-hardening` commit
  `7c2b381c0795d1933c13b55914c30900b2a0f63d`.
- Historical evidence snapshot:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-historical-spotify-identity-evidence-2026-07-30T02-10-30Z.json`
- Historical snapshot file SHA-256:
  `fd35a9caab3b7ebdc52a999ecabc8e507d72e29c359323d62908de20a4a0bf33`
- Historical snapshot canonical SHA-256:
  `57966b58d5d5ce16ec8ab38a09327052c78b091ad6c3f6db27ebd2cd61b4b49d`
- Source schema version: 17.

The replacement export ran once from `2026-07-31T02:02:13.6173017Z` through
`2026-07-31T02:02:15.4659011Z`. The transaction verified `repeatable read` and `read_only=on`
before executing the allowlisted SELECT queries. No database write was possible or attempted.
No further main-database access occurred.

The earlier failed transaction used the same isolation and read-only settings, rolled back, and
created no file. Its command did not record a start timestamp. It failed because
`jsonb_array_elements_text` received a scalar JSON value. The repaired exporter validates each
UUID and converts one deterministic comma-delimited parameter to `uuid[]` with
`string_to_array($1, ',')::uuid[]`. An isolated PostgreSQL regression reproduced
`cannot extract elements from a scalar` for the old expression and returned the expected UUID set
for the repaired expression.

## Sanitized historical snapshot

| Measure                                                | Count |
| :----------------------------------------------------- | ----: |
| Artists                                                |   593 |
| Historical releases                                    | 3,935 |
| Historical tracks                                      |   623 |
| Artists with at least one cutoff-safe complete release |   165 |
| Artists without such a release                         |   428 |
| Usable complete releases                               |   283 |
| Usable tracks                                          |   615 |

The latest included release observation was `2026-07-30T02:08:41.425Z`; the latest track
observation was `2026-07-30T02:07:31.308Z`. Both precede the cutoff.

The snapshot contains only canonical artist identity, confirmed Spotify artist IDs, sanitized
historical release fields, track fields, completeness state, and exclusion reasons. Validation
rejects credentials, tokens, account data, raw payloads, request telemetry, cooldowns, campaign
state, scheduler state, locks, leases, playlist state, feed state, artwork, previews, and Apple
data.

Canonical content uses NFC strings and deterministic artist, release, track, reason, credit, and
marker ordering. The canonical SHA-256 covers compact canonical content and excludes only the
`canonicalContentSha256` field. The file-byte SHA-256 covers the exact indented,
newline-terminated file containing that canonical hash. Generation was performed twice in memory
and required identical canonical hashes before the file was written once.

## Evidence inventory

The deterministic 593-row inventory is
`docs/itunes-full-watchlist-identity-evidence.csv`, SHA-256
`8852c14806bbb564c59642f67a6c84466c31ded165f4990e9dc5889c7ab087bb`.

The stricter anchor scorer found 164 artists with at least one usable identity anchor and 429
without one. This differs by one from the snapshot's 165 cutoff-safe complete-release artists
because the scorer also requires provable canonical primary credit and rejects duplicate or
otherwise unsafe sole anchors.

For the 285 search-stage ambiguous artists:

| Evidence state                             | Artists |
| :----------------------------------------- | ------: |
| Zero usable anchors                        |     198 |
| One usable anchor                          |      51 |
| Two or more usable anchors                 |      36 |
| Strong anchor quality                      |      46 |
| Moderate anchor quality                    |      41 |
| Complete album or EP evidence              |       3 |
| Only generic titles                        |       4 |
| Only remix or feature evidence             |      17 |
| Reached the 10-result limit                |     188 |
| Result-limited and lacking strong evidence |     159 |

Result-limit and usable-anchor cross-tabulation:

| Result-limit state | Zero anchors | One anchor | Two or more |
| :----------------- | -----------: | ---------: | ----------: |
| Reached 10         |          130 |         37 |          21 |
| Below 10           |           68 |         14 |          15 |

## Deterministic anchor rules

Positive evidence includes exact canonical primary credit, complete retrieval, album or EP type,
a distinctive release title, multiple distinctive track titles, stable version markers,
pre-cutoff observation, and independent releases. Each release records its score, quality,
included evidence, excluded evidence, exclusion reasons, and deterministic selection order.

The scorer penalizes or rejects generic one-word titles, intro or outro style titles, weak version
markers without other evidence, feature-only credit, compilation appearance, incomplete
retrieval, conflicting credit, duplicate editions, missing track evidence, and cutoff-unsafe
state. A title such as `Intro`, `Home`, or `Alive` cannot independently become a strong anchor.
Multiple independent anchors strengthen the artist-level score.

## Strategy A: brute-force baseline

The existing projection applies album and song lookup to every currently returned plausible Apple
candidate ID.

| Measure                   |                       Value |
| :------------------------ | --------------------------: |
| Plausible IDs             |                       1,693 |
| Existing album cache hits |                         101 |
| Existing song cache hits  |                         101 |
| New album requests        |                       1,592 |
| New song requests         |                       1,592 |
| Total new requests        |                       3,184 |
| Shards of at most 150     |                          22 |
| Pacing floor              | 10,188,800 ms, or 2:49:48.8 |

`3,184` is the brute-force request projection for the 1,693 currently returned plausible IDs. It
is not proof of the complete identity-resolution cost.

## Strategy B: album-first retrospective

The original 50-artist cohort contained 24 search-stage ambiguous controls. The corrected cached
evidence confirmed 13 identities. Under the deterministic retrospective album rule, two or more
independent exact release matches resolve 12 controls with album evidence alone. The remaining 12
controls, comprising one deferred evidence-confirmed control and the 11 unresolved controls,
require song evidence or remain ambiguous. No known control mapping was changed incorrectly.

Those 12 controls represented 75 of the 119 plausible candidate IDs in the 24 ambiguous controls.
Applying that measured candidate ratio to the full request projection gives:

| Measure                 |                 Estimate |
| :---------------------- | -----------------------: |
| New album requests      |                    1,592 |
| New song requests       |                    1,003 |
| Total                   |                    2,595 |
| Reduction from baseline |            589, or 18.5% |
| Shards                  |                       18 |
| Pacing floor            | 8,304,000 ms, or 2:18:24 |

This is a retrospective extrapolation from 24 ambiguous original-cohort artists. It is not proven
for all 593 artists and does not address identities omitted from the first 10 search results.

## Strategy C: historical-title targeted search

The planned request classes are separate from legacy artist-name search:

- Collection-title search: `/search`, entity `album`, using a distinctive historical release
  anchor.
- Track-title search: `/search`, entity `song`, using a distinctive historical track anchor.
- Artist plus release-title search: a normalized combined term when a future provider method
  explicitly supports it.
- Artist plus track-title search: a normalized combined term when a future provider method
  explicitly supports it.

The provider now exposes one narrow targeted collection-search method for the separately
authorized bounded experiment. It accepts only the exact frozen album-search parameter shape, a
v2 cache identity, and one network attempt. The dedicated executor remains incapable of song,
collection-detail, batch, or dynamic fallback requests.

A result never confirms identity by rank alone. It must have compatible artist naming and exact
distinctive title evidence, then add compatible release type, version, date, track count, or
independent anchors as available. An ID outside the original top 10 may be represented and
reviewed, but it is accepted only after strong corroboration. One generic title is insufficient.

## Strategy D: hybrid bounds

The hybrid accepts the 307 unique exact search-stage mappings without a new request. It uses
targeted searches for the 87 unresolved artists with strong or moderate anchors, then album-first
fallback and song lookup only when required. The remaining 199 unresolved artists have no usable
anchor and are likely fallback cases.

| Bound                  | Requests | Reduction from 3,184 | Shards | Pacing floor |
| :--------------------- | -------: | -------------------: | -----: | -----------: |
| Best case              |      373 |                2,811 |      3 | 1,193,600 ms |
| Expected planning case |    2,067 |                1,117 |     14 | 6,614,400 ms |
| Worst case             |    2,946 |                  238 |     20 | 9,427,200 ms |

The maximum modeled work is 22 requests for an artist with 10 candidates: two targeted searches,
10 album lookups, and 10 song lookups.

The expected case assumes targeted corroboration for 60% of strong-anchor artists and 30% of
moderate-anchor artists, one album confirmation for each targeted success, and the measured
75/119 original-pilot candidate ratio for song fallback. The targeted success rates are explicit
planning assumptions, not live measurements.

## Cache behavior versioning

No migration is required. The 801 existing normalized rows remain readable under their unchanged
legacy `/search?...` and `/lookup?...` identities.

Future targeted searches use a schema-free `itunes-cache:v2` identity derived from:

- provider;
- storefront;
- operation type;
- exact normalized request parameters;
- provider behavior version; and
- response-normalization version.

Changing any dimension changes the identity. Identical repeated inputs are idempotent. New
targeted-search identities cannot collide with legacy artist search. An unchanged legacy album
lookup can still reuse its exact legacy cache row.

## Bounded experiment

The dry-run manifest is:

`C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-adaptive-identity-experiment-plan-2026-07-30T02-10-30Z.json`

- File SHA-256:
  `b24b51bfbeba03c75e74ed2a59d5d7c7bff0dcadce5e12147af9c2c6413211e0`
- Canonical SHA-256:
  `271012f7cb5b8c2d95e6a59b76a51dbc67f4b76452b2dcbff342530c3869683d`
- Artists: 50.
- Planned operations: 98.
- Existing cache hits: 19.
- New requests: 79.
- Album-first operations: 73.
- Targeted-search operations: 25.
- New-request pacing floor: 252,800 ms, or 4:12.8.
- Concurrency: one.
- Minimum request-start interval: 3,200 ms.

The cohort includes all 13 evidence-confirmed original controls, all 11 original unresolved
controls, and deterministic coverage of two-to-three candidates, four-to-nine candidates,
10-result truncation, strong album anchors, single-only anchors, remix or feature-heavy evidence,
and no usable anchors. Eleven evidence-confirmed controls receive both targeted-search and
album-first planned operations.

The manifest's canonical SHA-256 excludes only `canonicalContentSha256` and uses recursively
sorted compact JSON. The file SHA-256 covers the final indented, newline-terminated manifest.
Request identities are unique and ordered deterministically.

The experiment is authorized only through the dedicated command documented in
`docs/itunes-adaptive-identity-experiment.md`. Live execution remains blocked until the
credential-free verification checkpoint is committed, pushed, synchronized, and clean.

## Interpretation limits

- The 225 result-limited census artists retain truncation risk. The correct Apple identity may be
  outside the current candidate set.
- Search-only mapping coverage does not equal release-discovery coverage.
- Historical identity evidence is not prospective target-window truth.
- The Strategy B full-watchlist estimate is an extrapolation.
- Strategy C has no live control performance yet.
- The hybrid expected bound depends on stated assumptions.
- No production provider decision is authorized.
