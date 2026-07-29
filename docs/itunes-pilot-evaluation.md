# iTunes Search API Pilot Evaluation

Generated: 2026-07-29T01:30:14.464Z

## Environment

- Feature branch: `codex/itunes-discovery`
- Branch-point commit: `c602929142291da9b99ee126c2ecf73b39b528b3`
- Implementation commit: `42db979e779e82769330efba4891087184260fa6`
- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Compose project: `codex_world_1_itunes`
- Web port: `3001`; PostgreSQL ports: `55433` and `55434`
- Pilot database: `radar_itunes`; test database: `radar_itunes_test`
- Snapshot: 2026-07-29T01:00:20.642Z
- Ground-truth window: 2026-05-30 through 2026-07-29
- Live start: 2026-07-29T01:23:16.853Z
- Live end: 2026-07-29T01:29:17.489Z

## Cohort

- Artists: 50
- Positive: 30
- Negative: 10
- Identity stress: 10
- Frozen Spotify releases: 106
- Stored genre representation: unavailable in the source schema; no genres were inferred.

| Artist            | Cohort          |
| ----------------- | --------------- |
| 12th Planet       | identity_stress |
| 1788-L            | identity_stress |
| 1991              | identity_stress |
| 2TD               | identity_stress |
| 3LAU              | identity_stress |
| 4B                | identity_stress |
| A.M.C             | identity_stress |
| Au5               | identity_stress |
| BUNT.             | identity_stress |
| Kx5               | identity_stress |
| Alison Wonderland | negative        |
| Andromedik        | negative        |
| Anki              | negative        |
| Anto              | negative        |
| Apashe            | negative        |
| ATLiens           | negative        |
| Autograf          | negative        |
| Babsy.            | negative        |
| Bad Chicken!      | negative        |
| Bad Computer      | negative        |
| Alok              | positive        |
| ATTLAS            | positive        |
| BARELY ALIVE      | positive        |
| BIJOU             | positive        |
| BROHUG            | positive        |
| Deorro            | positive        |
| Don Diablo        | positive        |
| Dr. Ozi           | positive        |
| G-Space           | positive        |
| GRiZ              | positive        |
| Habstrakt         | positive        |
| Leotrix           | positive        |
| Lit Lords         | positive        |
| Martin Garrix     | positive        |
| MashBit           | positive        |
| Monxx             | positive        |
| MUST DIE!         | positive        |
| NURKO             | positive        |
| NXSTY             | positive        |
| REAPER            | positive        |
| Rueben            | positive        |
| SampliFire        | positive        |
| SISTO             | positive        |
| SVDDEN DEATH      | positive        |
| Vibe Chemistry    | positive        |
| Virus Syndicate   | positive        |
| William Black     | positive        |
| YUSSI             | positive        |
| Zeds Dead         | positive        |
| ZHU               | positive        |

## Before-correction diagnostic

This section freezes the first-pilot decomposition before identity or release-matching behavior is
changed. It uses only stored run `e51a57f6-2f95-4e6d-868b-f30ed43f90fd`, its normalized pilot
rows, and its cached responses.

### Artist mapping

- The 26 exact-confirmed artists contained 52 frozen Spotify releases across 16 artists with
  ground truth. Forty-one releases matched, for 78.8% mapped-release recall. All 16 artists had at
  least one match, for 100.0% mapped-artist recall.
- The 24 ambiguous artists contained 54 frozen Spotify releases across 19 artists with ground
  truth. None could be evaluated after the first-stage identity failure.
- Every ambiguous mapping was caused by multiple exact normalized Apple artist names.
- Search result counts ranged from 2 to 10. The exact competing-name subset contained 119 distinct
  Apple artist IDs, including 85 candidates across the 19 ambiguous artists with ground truth.
- Punctuation or alias differences and collaborative naming caused no first-stage ambiguity.
  Same-name candidates were likely unrelated, but stored search data alone was insufficient to
  choose among them.

| Ambiguous artist | Search candidates | Exact-name competitors |
| ---------------- | ----------------: | ---------------------: |
| 12th Planet      |                 2 |                      2 |
| 1991             |                10 |                      5 |
| 4B               |                10 |                      9 |
| A.M.C            |                10 |                     10 |
| Alok             |                10 |                      8 |
| Anki             |                10 |                      9 |
| Anto             |                10 |                      8 |
| ATTLAS           |                 6 |                      5 |
| BIJOU            |                10 |                      8 |
| BROHUG           |                 2 |                      2 |
| BUNT.            |                10 |                      4 |
| Babsy.           |                10 |                      5 |
| Don Diablo       |                 5 |                      2 |
| G-Space          |                10 |                      3 |
| GRiZ             |                10 |                      5 |
| MashBit          |                 2 |                      2 |
| NXSTY            |                10 |                      4 |
| REAPER           |                10 |                     10 |
| Rueben           |                10 |                      2 |
| SampliFire       |                 2 |                      2 |
| SISTO            |                10 |                      4 |
| William Black    |                 7 |                      2 |
| YUSSI            |                10 |                      6 |
| ZHU              |                10 |                      2 |

### Release matching

- The mapped group produced 3 exact matches, 38 strong probable matches, 2 ambiguous matches, and
  9 Spotify ground-truth misses.
- Neither ambiguous match had an exact normalized-title candidate. Both were tied partial-title
  matches.
- None of the 9 missed Spotify releases had an exact normalized title in the stored Apple
  collections. The original matcher recorded them as lacking any title-compatible collection.
- No match was explicitly rejected because of date, version, track list, or artist credit. Artist
  credit was not part of the release-pair score.
- One accepted strong probable match exceeded 7, 14, 30, and 60 days. It paired BARELY ALIVE's
  `100% NO AI` releases 93 days apart.

### Candidate-prevalence bias

The first run collected catalogs only for exact-confirmed artists. Cohort prevalence therefore
mixes catalog behavior with the 48.0% mapping failure and must not be treated as a random-watchlist
estimate.

| Cohort          |  Window | Artists with candidates | Cohort prevalence | Mapped prevalence |
| --------------- | ------: | ----------------------: | ----------------: | ----------------: |
| Positive        |  7 days |                 8 of 30 |             26.7% |             57.1% |
| Positive        | 14 days |                10 of 30 |             33.3% |             71.4% |
| Positive        | 30 days |                14 of 30 |             46.7% |            100.0% |
| Positive        | 60 days |                14 of 30 |             46.7% |            100.0% |
| Negative        |  7 days |                 0 of 10 |              0.0% |              0.0% |
| Negative        | 14 days |                 0 of 10 |              0.0% |              0.0% |
| Negative        | 30 days |                 1 of 10 |             10.0% |             14.3% |
| Negative        | 60 days |                 3 of 10 |             30.0% |             42.9% |
| Identity stress |  7 days |                 0 of 10 |              0.0% |              0.0% |
| Identity stress | 14 days |                 1 of 10 |             10.0% |             20.0% |
| Identity stress | 30 days |                 2 of 10 |             20.0% |             40.0% |
| Identity stress | 60 days |                 2 of 10 |             20.0% |             40.0% |

The original 433-of-593 candidate-artist projection used 19 of 26 mapped artists from a cohort
deliberately enriched with 30 positive artists. It is not a valid full-watchlist estimate.

## Mapping

- Exact confirmed: 26
- Evidence confirmed: 0
- Ambiguous: 24
- No match: 0
- Rejected: 0
- Mapping rate: 52.0%
- Ambiguity and artist-level identity failure rate: 48.0%
- Positive cohort: 14 exact confirmed, 16 ambiguous
- Negative cohort: 7 exact confirmed, 3 ambiguous
- Identity-stress cohort: 5 exact confirmed, 5 ambiguous
- Examples of multiple exact-name candidates include Alok, ATTLAS, BIJOU, Don Diablo, GRiZ,
  REAPER, William Black, and ZHU.
- The stored-alias evidence route was implemented but confirmed no artists in this snapshot. The
  live workflow did not perform additional candidate catalog lookups to apply frozen release-title
  overlap to ambiguous same-name results. This is a material mapping limitation and should be
  corrected in a separate credential-free milestone before another live run.

## Requests

- Total network requests: 108
- Search: 50
- Album lookups: 26
- Song lookups: 26
- Batched lookups: 4
- Collection-detail lookups: 2
- Cache hits: 0
- Runtime: 6.01 minutes
- Requests per minute: 17.97
- Minimum request-start interval: 3201 ms
- Overlapping request pairs: 0
- Largest response: 3,018,593 bytes, below the 5 MiB response ceiling
- HTTP errors: 0
- Retry-After values: none
- Stop reason: `pilot_workflow_completed`

## Discovery

- Deduplicated collections: 3386
- Deduplicated tracks: 4495
- Collections in 7/14/30/60 days: 9 / 18 / 40 / 76
- Tracks in 7/14/30/60 days: 12 / 29 / 72 / 114
- Album lookup only: 880
- Song lookup only: 1361
- Both lookup paths: 1145
- Within 60 days: 0 album-only, 25 song-only, and 51 found through both paths
- Appearance candidates: 947 across the returned catalog; 14 within 60 days
- Recent collection types: 38 single, 4 EP, 27 album, 5 remix, and 2 live
- Cross-path duplicate collection observations removed: 1145
- Duplicate track observations removed: 0
- Eighteen of 26 song lookups returned exactly 200 tracks. Two album lookups returned exactly 200
  collections. With no proven paging mechanism, these artists have explicit truncation risk.

## Comparison

- Artist-level recall: 45.7%
- Release-level recall: 38.7%
- Candidate precision proxy for the 60-day comparison window: 52.6% (40 distinct matched
  candidates of 76)
- All-catalog precision proxy: 1.2%. This is not the primary comparison metric because the lookup
  results include old catalog releases outside the frozen ground-truth window.
- Recall at 7/14/30/60 days: 46.2% / 42.9% / 39.6% / 38.7%
- Exact matches: 3
- Strong probable matches: 38
- Ambiguous matches: 2
- Apple-only or unresolved: 36 recent candidates; 3345 across the full returned catalog
- Spotify releases missed by iTunes: 9
- Identity mapping failures: 24 artists, represented by 54 frozen release rows
- Release-type recall:

| Type                           | Frozen releases | Matched | Recall |
| ------------------------------ | --------------: | ------: | -----: |
| Album                          |               5 |       2 |  40.0% |
| EP                             |              10 |       6 |  60.0% |
| Feature or credited appearance |              25 |       7 |  28.0% |
| Remix                          |               8 |       4 |  50.0% |
| Single                         |              58 |      22 |  37.9% |

- Appearance recall: 28.0% using the frozen `feature` category
- Matched-release date agreement: 38 of 41 exact, 39 of 41 within one day, and an average absolute
  difference of 2.46 days
- One strong probable match paired BARELY ALIVE's `100% NO AI` releases 93 days apart. This exposes
  a date-compatibility weakness and means the probable-match count is not equivalent to manually
  confirmed precision.
- Track-count agreement: 41 of 41 matched comparisons; 42 of 43 when ambiguous comparisons are
  included
- Request efficiency: 4.15 calls per mapped artist, 1.42 calls per recent collection candidate,
  and 2.63 calls per matched frozen release

## Batching

- album, size 5: unsafe; 472/752 results; missing_collections:278, misattributed:78
- song, size 5: unsafe; 1000/1000 results; misattributed:147
- album, size 10: unsafe; 720/1267 results; missing_collections:523, misattributed:123
- song, size 10: unsafe; 1812/1812 results; misattributed:367
- Proven safe batch size: none
- Response sizes were 457,516 and 1,658,190 bytes for size 5, then 699,560 and 3,018,593
  bytes for size 10, for album and song lookups respectively.
- Song result counts could equal the individual union while artist attribution still failed. Album
  batches also omitted large parts of the individual baseline. Normal iTunes artist-ID batching is
  therefore not acceptable for production.

## Projected 593-Artist Operation

- One-time mapping requests: 593
- Recurring individual lookup requests: 1186
- Recurring batched lookup requests: not projected because batching was not proven safe
- Individual lookup runtime at 3.2 seconds: 63.3 minutes
- Projected mapped artists with recent candidates: 433, based on 19 of 26 mapped pilot artists
- Projected candidate-driven Spotify confirmation requests: 433 as a lower-bound estimate of one
  request per candidate artist
- Projected reduction from 593 Spotify artist-catalog requests: 160 (27.0%)
- Expected weekly iTunes lookup duration: 63.3 minutes
- This projection assumes 593 artists are already mapped. The observed 52.0% mapping rate does not
  support that assumption without a better identity-resolution stage.

## Corrected identity and release-matching rerun

The correction reran the same 50 artists and frozen 106-release snapshot. It reused all 50 artist
searches and all 52 selected-catalog requests from the first run. It made 150 new individual
requests to examine 75 complete same-name candidate catalogs. It did not make a batch request or
partially examine the next artist.

### Before and after

| Measure                    |   First pilot | Corrected rerun |
| -------------------------- | ------------: | --------------: |
| Exact-confirmed artists    |            26 |              26 |
| Evidence-confirmed artists |             0 |              13 |
| Ambiguous artists          |            24 |              11 |
| No match                   |             0 |               0 |
| Rejected                   |             0 |               0 |
| Mapping rate               |         52.0% |           78.0% |
| Mapped-release recall      |  41/52, 78.8% |    73/94, 77.7% |
| Full-cohort release recall | 41/106, 38.7% |   73/106, 68.9% |
| Mapped-artist recall       | 16/16, 100.0% |   29/29, 100.0% |
| Full-cohort artist recall  |  16/35, 45.7% |    29/35, 82.9% |

Mapped-only release recall did not improve. The material full-cohort gain came from resolving 13
previous identity failures and evaluating their catalogs. The corrected unmatched decomposition is:

- 14 genuine catalog misses, where the selected iTunes catalog had no title candidate
- 12 mapping-caused misses attached to unresolved artists
- 5 ambiguous release matches and 2 invalid release matches, or 7 matcher-caused misses

### Recall by inclusive calendar window

The same inclusive calendar-day definition used by the first report is retained for direct
comparison.

| Window  |   First pilot | Corrected rerun |
| ------- | ------------: | --------------: |
| 7 days  |   6/13, 46.2% |    11/13, 84.6% |
| 14 days |  12/28, 42.9% |    23/28, 82.1% |
| 30 days |  21/53, 39.6% |    36/53, 67.9% |
| 60 days | 41/106, 38.7% |   73/106, 68.9% |

### Recall by frozen release type

| Type                           | Frozen |    First pilot | Corrected rerun |
| ------------------------------ | -----: | -------------: | --------------: |
| Single                         |     58 |      22, 37.9% |       48, 82.8% |
| EP                             |     10 |       6, 60.0% |        4, 40.0% |
| Album                          |      5 |       2, 40.0% |        4, 80.0% |
| Remix                          |      8 |       4, 50.0% |        5, 62.5% |
| Feature or credited appearance |     25 |       7, 28.0% |       12, 48.0% |
| Live                           |      0 | not measurable |  not measurable |
| Compilation                    |      0 | not measurable |  not measurable |

The snapshot stores no genres, so separate EDM or bass-music recall cannot be measured without
inventing genre assignments. Remix and appearance recall improved but remains too weak for primary
discovery.

### Matching quality

- Exact matches: 5
- Strong probable matches: 68
- Ambiguous matches: 5
- Invalid matches: 2
- Accepted matches above 7, 14, or 30 days: 0 at every threshold
- The prior BARELY ALIVE `100% NO AI` 93-day probable match is now `invalid_match`.
- Track-count conflicts, incompatible version markers, and date differences above 30 days are not
  accepted.
- The known false acceptance was removed. A general false-match rate cannot be claimed because the
  other 73 accepted pairs were not independently labeled by a human.

### Corrected operation

- Run ID: `0f719ae6-bb42-48a0-b24c-557a0c2facb5`
- Status: `controlled_partial`
- Stop reason: `correction_candidate_budget_prioritization_complete`
- Runtime: 8.48 minutes
- New requests: 150, comprising 75 album and 75 song lookups
- Cache hits: 102, comprising 50 search, 26 album, and 26 song lookups
- Minimum request-start interval: 3201 ms
- Concurrent request overlap: 0
- HTTP errors and Retry-After rows: 0
- Batch requests: 0
- Candidate catalogs examined: 75
- Candidate catalogs skipped to avoid exceeding the budget: 10, all belonging to the next complete
  artist

### Cohort-specific operational projection

The candidate rate is the share of all artists in that cohort with at least one iTunes collection
in the stated window. These deliberately selected groups are scenarios, not estimates of the
593-artist watchlist.

| Scenario               |   7-day rate | 7-day candidates of 593 | Spotify reduction |  60-day rate | 60-day candidates of 593 | Spotify reduction |
| ---------------------- | -----------: | ----------------------: | ----------------: | -----------: | -----------------------: | ----------------: |
| Positive cohort        | 14/30, 46.7% |                     277 |        316, 53.3% | 26/30, 86.7% |                      514 |         79, 13.3% |
| Negative cohort        |   0/10, 0.0% |                       0 |       593, 100.0% |  3/10, 30.0% |                      178 |        415, 70.0% |
| Identity-stress cohort |  1/10, 10.0% |                      59 |        534, 90.0% |  3/10, 30.0% |                      178 |        415, 70.0% |

The positive cohort was intentionally enriched for recent releases, while the negative and
identity-stress groups contain only ten artists each. None is a defensible prevalence estimate.
The original 433-of-593 projection pooled mapped artists from this biased cohort and therefore was
not valid as a watchlist projection.

- Minimum one-time mapping cost remains 593 artist searches. Same-name ambiguity adds individual
  catalog evidence requests, but this selected cohort cannot estimate that overhead reliably.
- Looking up all 593 artists weekly costs 1,186 individual requests and about 63.3 minutes at the
  required pacing.
- Scaling the observed 78.0% mapping rate would cover about 463 artists, cost about 926 weekly
  requests, and take about 49.4 minutes, while leaving the other artists undiscovered.
- No unsafe batch result is used in any estimate.
- A reliable weekly candidate-volume and Spotify-request-reduction estimate requires a randomized
  or full-watchlist Apple-only sweep.

### Corrected decision

**Useful only as a supplemental source.**

Mapping coverage and seven-day recall improved materially, and the known 93-day false acceptance
was removed. The result still has 22.0% unresolved artist identities, 48.0% appearance recall,
62.5% remix recall, 14 catalog misses, 5 ambiguous release matches, and no defensible watchlist-wide
request-reduction estimate. This is not sufficient for a primary candidate-discovery source.

If further work is desired, use a separate representative pilot with randomized or full-watchlist
sampling. Keep this branch unmerged in the current milestone.

## Limitations

- Apple publishes this API only in archived documentation.
- The documented allowance is approximate and subject to change.
- Results vary by storefront.
- Lookup results are capped at 200 and no paging mechanism is proven.
- Artist-name mapping remains ambiguous for same-name and non-exact identities.
- Song lookup does not prove complete appearance coverage.
- Current Apple catalog results are compared with a frozen historical Spotify snapshot.
- Spotify ground truth can itself contain partial artist catalogs.
- Unmatched Apple candidates are not automatically false positives.
- No UPC or ISRC claim is made because those identifiers were not part of the normalized pilot response.
- One snapshot cannot prove future Apple release-availability timing.
- Apple promotional content is not downloaded, cached, rendered, or used; only normalized metadata and validated store links are retained.

## Integrity

- Request count: 108 of 200
- Minimum start interval: 3201 ms
- Concurrent request overlap: none
- Duplicate mappings, collections, tracks, and match identity rows: none
- Cached artwork or preview fields: none
- Unsafe persisted Apple store URLs: none
- Pilot Spotify request events: 0
- Pilot MusicBrainz request events: 0
- Production feed items, non-mock release candidates, and playlist exports in the pilot database: 0

## Decision

**Not reliable enough for this watchlist under the tested mapping workflow.**

Do not merge or use iTunes as the primary discovery source from this result. The next milestone
should correct the specific ambiguous-identity workflow, including bounded release-title evidence
for competing exact-name candidates and a stricter date rule, then repeat the isolated pilot. If
that correction does not materially improve the 52.0% mapping rate and 38.7% release recall, reject
iTunes rather than integrating it. SoundCloud automation remains prohibited under current
repository policy, and paid Apple access is outside the current no-paid-provider constraint.
