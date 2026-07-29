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
