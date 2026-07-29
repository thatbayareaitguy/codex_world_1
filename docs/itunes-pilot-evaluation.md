# iTunes Search API Pilot Evaluation

This document separates historical live-run measurements from the leakage-safe offline evaluation.
It does not treat Spotify releases used to resolve an Apple artist identity as independently
discovered by Apple.

## 1. Environment and cohort

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Frozen snapshot ID: `5c7c27ec-9432-4457-8787-aa3bba582eea`
- Canonical sanitized-content SHA-256:
  `48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a`
- Snapshot timestamp: `2026-07-29T01:00:20.642Z`
- Frozen date range: `2026-05-30` through `2026-07-29`
- Artists: 50, comprising 30 positive, 10 negative, and 10 identity-stress artists
- Frozen Spotify releases: 106 across 35 artists
- Stored genres: unavailable, and none were inferred
- Pilot database: isolated `radar_itunes` on `127.0.0.1:55433`

The expected SHA is the hash of the sanitized canonical JSON object with its `snapshotHash` field
excluded. It is not the byte-level hash of the indented file.

The cohort was deliberately enriched for recent releases and difficult names. It is not a random
sample of the 593-artist watchlist, and this evaluation does not extrapolate its prevalence to that
watchlist.

## 2. First-pilot baseline

Run `e51a57f6-2f95-4e6d-868b-f30ed43f90fd` completed with 108 network requests under a 200-request
run budget.

### Mapping and release baseline

- Exact-confirmed mappings: 26 of 50, or 52.0%
- Evidence-confirmed mappings: 0 of 50, or 0.0%
- Ambiguous mappings: 24 of 50, or 48.0%
- No-match and rejected mappings: 0 of 50
- Accepted release matches: 41 of 106, or 38.7%
- Exact matches: 3 of 106, or 2.8%
- Strong probable matches: 38 of 106, or 35.8%
- Ambiguous matches: 2 of 106, or 1.9%
- Invalid matches: 0 of 106
- Mapped-only release recall: 41 of 52, or 78.8%
- Mapped-only artist recall: 16 of 16, or 100.0%
- Full-cohort artist recall: 16 of 35 Spotify-positive artists, or 45.7%

### Inclusive release-window recall

| Window                                 | Matched | Frozen releases | Recall |
| -------------------------------------- | ------: | --------------: | -----: |
| 7 days, 2026-07-22 through 2026-07-29  |       6 |              13 |  46.2% |
| 14 days, 2026-07-15 through 2026-07-29 |      12 |              28 |  42.9% |
| 30 days, 2026-06-29 through 2026-07-29 |      21 |              53 |  39.6% |
| 60 days, 2026-05-30 through 2026-07-29 |      41 |             106 |  38.7% |

### Release-type recall

| Frozen type                    | Matched | Frozen releases | Recall |
| ------------------------------ | ------: | --------------: | -----: |
| Single                         |      22 |              58 |  37.9% |
| EP                             |       6 |              10 |  60.0% |
| Album                          |       2 |               5 |  40.0% |
| Remix                          |       4 |               8 |  50.0% |
| Feature or credited appearance |       7 |              25 |  28.0% |

All 24 ambiguous mappings were caused by competing exact normalized names. The first pilot also
accepted BARELY ALIVE's `100% NO AI` despite a 93-day date difference. Album and song batch
experiments were unsafe and are excluded from every operational estimate.

## 3. Corrected implementation and live run

The correction added a deterministic second-stage resolver for competing exact-name candidates.
It compares individual cached candidate catalogs with frozen titles, tracks, dates, track counts,
version markers, and Apple credit IDs. It confirms only one uniquely strong candidate with no
conflict and a score margin of at least two.

The release matcher now rejects incompatible version markers, track-count conflicts, and date
differences above 30 days. Differences above 14 days remain ambiguous. No batch evidence is used.

Run `0f719ae6-bb42-48a0-b24c-557a0c2facb5` ended `controlled_partial` at its deterministic
150-request correction budget:

- New network requests: 150, comprising 75 album and 75 song lookups
- Cache hits: 102, comprising 50 searches, 26 album lookups, and 26 song lookups
- Candidate catalogs examined completely: 75
- Candidate catalogs skipped before partially examining the next artist: 10
- Runtime: 8.48 minutes
- Minimum request-start interval: 3201 ms
- Overlapping request pairs: 0
- HTTP errors and Retry-After rows: 0
- Batch requests: 0

### Corrected historical baseline

- Exact-confirmed mappings: 26 of 50, or 52.0%
- Evidence-confirmed mappings: 13 of 50, or 26.0%
- Ambiguous mappings: 11 of 50, or 22.0%
- Total corrected mapping rate: 39 of 50, or 78.0%
- Accepted release matches: 73 of 106, or 68.9%
- Exact matches: 5 of 106, or 4.7%
- Strong probable matches: 68 of 106, or 64.2%
- Ambiguous matches: 5 of 106, or 4.7%
- Invalid matches: 2 of 106, or 1.9%
- Mapped-only release recall: 73 of 94, or 77.7%
- Mapped-only artist recall: 29 of 29, or 100.0%
- Full-cohort artist recall: 29 of 35 Spotify-positive artists, or 82.9%

These corrected historical metrics are not leakage-safe because the same target-window Spotify
releases helped select 13 Apple identities.

### Corrected release counts

| Window  | Matched | Frozen releases | Recall |
| ------- | ------: | --------------: | -----: |
| 7 days  |      11 |              13 |  84.6% |
| 14 days |      23 |              28 |  82.1% |
| 30 days |      36 |              53 |  67.9% |
| 60 days |      73 |             106 |  68.9% |

| Frozen type                    | Matched | Frozen releases | Recall |
| ------------------------------ | ------: | --------------: | -----: |
| Single                         |      48 |              58 |  82.8% |
| EP                             |       4 |              10 |  40.0% |
| Album                          |       4 |               5 |  80.0% |
| Remix                          |       5 |               8 |  62.5% |
| Feature or credited appearance |      12 |              25 |  48.0% |

### EP regressions

- BARELY ALIVE, `100% NO AI`: first-run `strong_probable_match`, corrected
  `invalid_match`. The 93-day difference now triggers the date rule and corrects the known false
  match.
- Habstrakt, `Everyday (VIP)`: first-run `strong_probable_match`, corrected
  `ambiguous_match`. The stored Apple candidate is a related single-versus-EP appearance with a
  contained rather than identical title. This is stricter but still uncertain matching, not a
  proven false match.

The deterministic 80-row matcher audit is at `docs/itunes-pilot-match-review.csv`. It contains all
73 accepted, 5 ambiguous, and 2 invalid comparisons. It does not invent human labels or claim a
general false-match rate.

## 4. Leakage-safe offline evaluation

For each target window, mapping is frozen before its Spotify truth is read:

1. A unique exact normalized mapping remains `independent_exact`.
2. An evidence mapping is usable only when Spotify releases strictly before the target start
   reproduce the same selected Apple artist.
3. An evidence mapping that requires a release inside the scored window is
   `target_window_assisted` and excluded from the confusion matrix.
4. Every other mapping is unresolved.

Apple candidates are then determined only from the cached Apple collections, tracks, and credited
appearances dated inside the target window.

### Evidence-confirmed mapping provenance

| Artist        | Selected Apple ID | Score | Margin | 7-day      | 14-day     | 30-day     | 60-day   |
| ------------- | ----------------- | ----: | -----: | ---------- | ---------- | ---------- | -------- |
| ATTLAS        | 173455825         | 12.75 |  12.75 | historical | historical | assisted   | assisted |
| BIJOU         | 44873418          | 12.75 |  12.75 | historical | historical | historical | assisted |
| BROHUG        | 1115744117        | 12.75 |  12.75 | historical | historical | historical | assisted |
| BUNT.         | 1436090348        | 17.00 |  17.00 | historical | historical | historical | assisted |
| Don Diablo    | 76849154          |  8.50 |   8.50 | assisted   | assisted   | assisted   | assisted |
| G-Space       | 511671481         |  9.00 |   9.00 | historical | assisted   | assisted   | assisted |
| MashBit       | 1385123684        |  8.50 |   8.50 | historical | assisted   | assisted   | assisted |
| NXSTY         | 1336163773        | 12.75 |  12.75 | historical | assisted   | assisted   | assisted |
| SampliFire    | 696018289         | 12.75 |  12.75 | historical | historical | historical | assisted |
| SISTO         | 1526157202        | 17.00 |  17.00 | historical | historical | assisted   | assisted |
| William Black | 1297084102        | 12.00 |  12.00 | historical | historical | historical | assisted |
| YUSSI         | 1614562965        | 12.00 |   7.75 | historical | historical | historical | assisted |
| ZHU           | 261545033         |  8.00 |   8.00 | historical | historical | assisted   | assisted |

The complete provenance artifact at `docs/itunes-pilot-identity-provenance.csv` records, for every
mapping:

- Selected and competing Apple artist IDs
- Exact Spotify releases and tracks used as evidence
- Evidence dates and inside-or-before status for every target window
- Full deterministic score and margin
- Whether the mapping remains reproducible after target-window evidence is removed

For the 60-day evaluation, the frozen snapshot begins on the target start date. It contains no
older Spotify release evidence. Therefore all 13 evidence-confirmed mappings are
target-window-assisted at 60 days and none can be described as independent discovery.

### Mapping availability by window

| Window  | Independent exact | Historical evidence | Target-assisted, excluded | Unresolved | Safely mapped total |
| ------- | ----------------: | ------------------: | ------------------------: | ---------: | ------------------: |
| 7 days  |                26 |                  12 |                         1 |         11 |                  38 |
| 14 days |                26 |                   9 |                         4 |         11 |                  35 |
| 30 days |                26 |                   6 |                         7 |         11 |                  32 |
| 60 days |                26 |                   0 |                        13 |         11 |                  26 |

The 11 unresolved artists in every window are 12th Planet, 1991, 4B, A.M.C, Alok, Anki, Anto,
Babsy., GRiZ, REAPER, and Rueben.

### Artist-level confusion matrices

The confusion matrices include only independently or historically mapped artists. Their unit is
one artist, regardless of how many releases that artist has.

| Window  | Safe artists |  TP |  FP |  TN |  FN |        Recall |     Precision |   Specificity |         FPR |         FNR |
| ------- | -----------: | --: | --: | --: | --: | ------------: | ------------: | ------------: | ----------: | ----------: |
| 7 days  |           38 |   9 |   0 |  26 |   3 |   9/12, 75.0% |   9/9, 100.0% | 26/26, 100.0% |  0/26, 0.0% | 3/12, 25.0% |
| 14 days |           35 |  15 |   0 |  17 |   3 |  15/18, 83.3% | 15/15, 100.0% | 17/17, 100.0% |  0/17, 0.0% | 3/18, 16.7% |
| 30 days |           32 |  17 |   1 |  10 |   4 |  17/21, 81.0% |  17/18, 94.4% |  10/11, 90.9% |  1/11, 9.1% | 4/21, 19.0% |
| 60 days |           26 |  16 |   2 |   8 |   0 | 16/16, 100.0% |  16/18, 88.9% |   8/10, 80.0% | 2/10, 20.0% |  0/16, 0.0% |

False-positive artists:

- 7 days: none
- 14 days: none
- 30 days: Bad Computer
- 60 days: Alison Wonderland and Bad Computer

False-negative artists:

- 7 days: BUNT., Vibe Chemistry, and William Black
- 14 days: BUNT., Vibe Chemistry, and William Black
- 30 days: BUNT., Vibe Chemistry, Virus Syndicate, and William Black
- 60 days: none among the 26 independently mapped artists

## 5. Product-policy simulation

The simulated weekly policy sends unresolved mappings to Spotify, sends safely mapped Apple
candidates to Spotify for confirmation, and skips safely mapped Apple negatives.

| Window  | Cohort | Unresolved or assisted fallback | Safe Apple candidates | Deduplicated Spotify queries | Queries avoided |    Reduction | Spotify-positive queried | Positive artists skipped | Unnecessary Apple FP queries |
| ------- | -----: | ------------------------------: | --------------------: | ---------------------------: | --------------: | -----------: | -----------------------: | -----------------------: | ---------------------------: |
| 7 days  |     50 |                              12 |                     9 |                           21 |              29 | 29/50, 58.0% |             10/13, 76.9% |              3/13, 23.1% |                            0 |
| 14 days |     50 |                              15 |                    15 |                           30 |              20 | 20/50, 40.0% |             21/24, 87.5% |              3/24, 12.5% |                            0 |
| 30 days |     50 |                              18 |                    18 |                           36 |              14 | 14/50, 28.0% |             27/31, 87.1% |              4/31, 12.9% |                            1 |
| 60 days |     50 |                              24 |                    18 |                           42 |               8 |  8/50, 16.0% |            35/35, 100.0% |               0/35, 0.0% |                            2 |

The query totals are exact under the stated fallback rule, so no speculative optimistic or
pessimistic query bound is needed. Target-window-assisted mappings are treated as unresolved and
sent to Spotify.

Incorrectly skipped frozen releases:

- 7 and 14 days:
  - Vibe Chemistry, `Two Blueys`, Spotify `3dAN2CfniUb0keu79H1fAZ`, 2026-07-24
  - BUNT., `World Away`, Spotify `6k2I7QkXRPlWzylh7UsFIx`, 2026-07-24
  - William Black, `Flutters`, Spotify `6uUmp5LDUJ1BV8ZEa7yV35`, 2026-07-24
- 30 days adds:
  - Virus Syndicate, `Like This Ft. Virus Syndicate (Skybreak Remix)`, Spotify
    `1QzjYEk947JH1HCZHpC83x`, 2026-07-03
  - Vibe Chemistry, `Mate`, Spotify `6SP9EeXnFj67Kw0I7R9Wiw`, 2026-07-03
  - Virus Syndicate, `Shellingham (WC Remix)`, Spotify `6iWKdGshyuqG8289LNUNue`,
    2026-07-10
- 60 days: none among independently mapped artists

The seven-day result is the primary product signal: 29 of 50 Spotify artist queries would be
avoided, but 3 of 13 Spotify-positive artists would be incorrectly skipped. This tradeoff must be
tested on representative Apple-only data before any production decision.

## 6. Limitations

- The cohort is enriched and cannot establish representative prevalence or a 593-artist reduction.
- The 60-day snapshot contains no pre-window Spotify evidence for evidence-based identity
  validation.
- Apple catalogs are current cached observations compared with a frozen Spotify snapshot.
- Individual album and song lookups can reach their 200-result cap. Absence is not proven.
- Fourteen corrected rows previously called genuine catalog misses are now classified as `not
retrieved by tested workflow` or `mapped catalog contained no compatible title`. Lookup
  truncation remains possible for 10 of those 14 rows because the selected catalog reached a
  200-result bound.
- Five release comparisons remain matcher-ambiguous and two are matcher-rejected.
- Eleven artist identities remain unresolved.
- The 73 accepted comparisons lack independent human labels, so no general false-match rate is
  claimed.
- Stored genres are unavailable, so EDM or bass-music performance cannot be isolated.
- The iTunes Search API documentation is archived and describes an approximate allowance.
- No Apple approval, production quota, or stable future behavior is claimed.

## 7. Current decision

**A separate representative Apple-only shadow pilot is justified.**

This is not a decision to classify iTunes as a primary source, supplemental source, or rejected
source. The leakage-safe seven-day candidate filter shows:

- Recall of 9 of 12 safely mapped Spotify-positive artists, or 75.0%
- Precision of 9 of 9 Apple-flagged artists, or 100.0%
- 29 of 50 Spotify queries avoided, or 58.0%
- 3 of 13 total Spotify-positive artists incorrectly skipped, or 23.1%
- 12 artists requiring fallback because identity was unresolved or target-assisted

Those results are promising enough to justify a separate randomized or full-watchlist Apple-only
shadow pilot, but not production use. That pilot must measure prevalence without Spotify-assisted
identity leakage, preserve fallback for unresolved mappings, retain individual lookups, and
explicitly quantify truncation risk. Representative or full-watchlist prevalence remains unproven.

## 8. Final integrity state

- First run: 108 network requests, 0 cache hits, 108 request-event rows, budget 200
- Corrected run: 150 network requests, 102 cache hits, 252 request-event rows, budget 150
- Combined: 258 network requests, 102 cache-hit events, 360 request-event rows
- Normalized cache: 258 rows, one for each distinct successful network request identity
- Active pilot runs: 0
- Active pilot lease: none
- Offline-evaluation provider requests: 0
- Pilot Spotify and MusicBrainz request rows: 0
- Production feed and playlist writes: 0
- Original pilot and corrected-run records: unchanged
- Formatting and lint with zero warnings: passed
- Strict TypeScript across all packages: passed
- Unit tests: 336 passed in 46 files
- PostgreSQL integration tests: 84 passed in 15 files
- Migration drift: no schema changes
- Production build: passed
- Playwright: 23 passed
- Credential-free pilot doctor: `READY` with 18 migrations
- Artifact idempotence: all three generated artifacts retained identical SHA-256 hashes on a second
  provider-disabled evaluation run

The network ceiling is configurable per run. The database gate increments only the active run's
network `requestCount` and allows a request only while that count is below the lesser of the
persisted run budget and the configured client maximum. Cache hits create telemetry rows but do
not increment the network request count. The provider-state counter is cumulative telemetry and is
not the enforcement ceiling.

Offline artifacts:

- `docs/itunes-pilot-offline-evaluation.json`
- `docs/itunes-pilot-identity-provenance.csv`
- `docs/itunes-pilot-match-review.csv`
- `docs/itunes-pilot-handoff.md`

No live provider request, production write, migration, merge, or cherry-pick occurred during this
offline evaluation.
