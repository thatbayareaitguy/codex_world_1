# Apple Music Recent Validation, 25 Artists

Date: 2026-07-30

## Decision

Apple does not meet the milestone threshold for primary official-release discovery on this
stratified cohort. Mapping was 12 of 25, or 48.0%, full-cohort recall was 7 of 21, or 33.3%, and
mapped-artist recall was 7 of 12, or 58.3%. Primary recall was 5 of 13, or 38.5%. There were no
invalid directional remix matches, no HTTP 429, and no systematic endpoint failure, but mapping
and recall are below the required thresholds.

The immediate next milestone should be a credential-free correction for punctuation-equivalent
feature credits and EP suffix normalization, followed by replay of this stored evidence. It should
not be another broad live experiment. Production integration and merge remain unauthorized.

## Scope and gates

- Snapshot content hash:
  `48259f7e2016aa8bbbabf4baa7e3baf8d4f9e9b53b413dab56f9d4fc70e1278a`
- Evaluation time: `2026-07-29T23:59:59Z`
- Selection seed: `apple-recent-validation-25-v1`
- Strata: 10 positive, 10 negative, and 5 identity/catalog-stress artists
- Frozen in-scope releases: 21
- Profile: `optimized_four_source`
- Maximum: 175 starts, 20 minutes, concurrency one, minimum 1,100 ms between starts
- Pagination: prohibited and not followed

The credential-free forecast was 160 starts: 100 discovery, up to 25 mapping, up to 10 targeted
details, 25 retry contingency, and 15 starts of remaining headroom. The prior ten-artist replay
was 7 of 7 primary, 3 of 3 remixes, and 10 of 10 automated exact matches, with zero matcher misses,
zero invalid directional matches, and four unconfirmed Apple-only candidates.

## Artist results

`R/R/R/R` means the singles, full-albums, Top Songs, and remix-search endpoints all returned
results. `R/404/R/R` means the supported full-albums view was unavailable. `NA` means discovery
was not attempted because mapping remained ambiguous.

| Artist          | Stratum                 | Mapping          | Truth | Requests | Endpoints | Accepted or review result                                               |
| --------------- | ----------------------- | ---------------- | ----: | -------: | --------- | ----------------------------------------------------------------------- |
| SVDDEN DEATH    | positive                | search-confirmed |     3 |        4 | R/R/R/R   | `Dissent`, exact; two catalog misses                                    |
| ZHU             | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable album                                           |
| Alok            | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable EP                                              |
| Don Diablo      | positive                | ambiguous        |     2 |        0 | NA        | two mapping-unevaluable releases                                        |
| SISTO           | positive                | ambiguous        |     3 |        0 | NA        | three mapping-unevaluable singles                                       |
| Virus Syndicate | positive                | search-confirmed |     2 |        4 | R/R/R/R   | `Shellingham (WC Remix)`, exact; one matcher miss                       |
| Dr. Ozi         | positive                | search-confirmed |     2 |        4 | R/R/R/R   | `Titan`, exact; one matcher miss                                        |
| William Black   | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable single                                          |
| YUSSI           | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable single                                          |
| Leotrix         | positive                | search-confirmed |     3 |        4 | R/R/R/R   | `KEY BINDZ EP` and `Junkworld (Leotrix Remix)`, exact; one catalog miss |
| Babsy.          | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| Bad Chicken!    | negative                | search-confirmed |     0 |        4 | R/404/R/R | no accepted candidate                                                   |
| Bad Computer    | negative                | search-confirmed |     0 |        4 | R/404/R/R | one unconfirmed Apple-only candidate                                    |
| Apashe          | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                                   |
| Andromedik      | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                                   |
| GRiZ            | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| Anto            | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| Rueben          | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| Autograf        | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                                   |
| ATLiens         | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                                   |
| Au5             | identity/catalog stress | search-confirmed |     1 |        4 | R/R/R/R   | `Inverse`, exact                                                        |
| 2TD             | identity/catalog stress | search-confirmed |     1 |        4 | R/R/R/R   | `FEELIN`, exact                                                         |
| 1991            | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| 12th Planet     | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                            |
| 4B              | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                            |

All 12 mapped artists used four fresh discovery starts. The other 13 artists stopped after a safe
ambiguous mapping outcome. No no-match or rejected mapping occurred.

## Recall and error classification

### Mapping

- Existing-ID confirmed: 0
- Search-confirmed: 12
- Evidence-confirmed: 0
- Ambiguous: 13
- No-match: 0
- Rejected: 0
- Overall mapping rate: 12 of 25, or 48.0%

### Primary releases

- Singles: 3 of 9, or 33.3% full-cohort; 3 of 3 among mapped artists
- EPs: 2 of 3, or 66.7% full-cohort; 2 of 2 among mapped artists
- Albums: 0 of 1 full-cohort; no album artist mapped
- Combined primary: 5 of 13, or 38.5% full-cohort; 5 of 5 among mapped artists

### Remixes

- By the watched artist: 1 of 2 full-cohort; 1 of 1 among mapped artists
- Of the watched artist by another named remixer: 1 of 6 full-cohort and mapped
- Combined remix: 2 of 8, or 25.0% full-cohort; 2 of 7, or 28.6% among mapped artists
- Directionally uncertain accepted remixes: 0
- False directional matches: 0

### Combined

- Full-cohort recall: 7 of 21, or 33.3%
- Mapped-artist recall: 7 of 12, or 58.3%
- Exact matched releases: 7
- Strong probable: 0
- Ambiguous: 0
- Mapping-caused unevaluable releases: 9
- Matcher-caused misses: 2
- Catalog misses after successful mapping: 3
- Raw Apple-only candidate rows: 4
- Unconfirmed Apple-only candidates after reconciliation: 1
- Invalid accepted candidates: 0

The two matcher misses are punctuation-equivalent `Ft.` versus `(feat.)` remix titles returned by
Top Songs. The album representation of `KEY BINDZ EP` was also labeled Apple-only because suffix
normalization left the release-level form distinct, although Top Songs independently established
the release as exact. These are known deterministic normalization issues. The three catalog misses
are mapped remix releases for which no compatible first-page candidate was retrieved.

## Negative cohort

All ten negative artists had zero frozen in-scope releases. Nine produced no accepted candidate.
Bad Computer produced one unconfirmed Apple-only candidate, so the post-reconciliation review
burden is one candidate across ten negative artists. There were no invalid accepted candidates.

## Source contribution

| Source       | Requests | Unique exact releases | Duplicated exact releases | Raw Apple-only rows | Invalid |
| ------------ | -------: | --------------------: | ------------------------: | ------------------: | ------: |
| Singles      |       12 |                     4 |                         1 |                   2 |       0 |
| Full albums  |       12 |                     0 |                         0 |                   0 |       0 |
| Top Songs    |       12 |                     1 |                         1 |                   3 |       0 |
| Remix search |       12 |                     1 |                         0 |                   0 |       0 |

Top Songs added one unique exact primary release. It also found both punctuation-equivalent remix
matcher misses, so it continues to add potentially unique remix value even though those two were
not accepted by the current deterministic matcher.

## Request behavior

- New Apple HTTP starts: 71
- Mapping operations: 25, comprising 23 network starts and 2 mapping cache hits
- Singles: 12 fresh starts
- Full albums: 12 fresh starts
- Top Songs: 12 fresh starts
- Remix searches: 12 fresh starts
- Targeted detail: 0
- HTTP 200: 69
- HTTP 404: 2, both nonterminal supported full-albums views
- Retries: 0
- Discovery cache hits: 0
- Pagination: 0
- Minimum interval: 1,103 ms
- Maximum concurrency: 1
- Runtime: 80,292 ms
- Budget remaining: 104
- Cooldown: none

At the observed mix, scaling 71 starts for 25 artists gives about 1,684 starts for 593 artists and
at least 30.9 minutes of pacing. A recurring run with the observed 48% mapping rate and reusable
mappings would be about 1,139 discovery starts and 20.9 minutes. The all-mapped bounds remain
2,965 initial starts and 2,372 recurring starts, or at least 54.3 and 43.5 minutes respectively.
These are pacing floors, not provider allowances.

## Frozen free-iTunes comparison

The existing leakage-safe 30-day free-iTunes artifact, restricted offline to the same 25 names and
21 releases, gives:

| Metric                | Apple optimized validation | Frozen free iTunes |
| --------------------- | -------------------------: | -----------------: |
| Safe mapping          |               12/25, 48.0% |       14/25, 56.0% |
| Full-cohort recall    |                7/21, 33.3% |        8/21, 38.1% |
| Mapped release recall |                7/12, 58.3% |        8/14, 57.1% |
| Primary recall        |                5/13, 38.5% |        7/13, 53.8% |
| Remix recall          |                 2/8, 25.0% |         1/8, 12.5% |

The iTunes artifact contains no same-25 request attribution. Its measured 258 starts cover the
complete 50-artist two-run pilot and are not directly comparable with Apple's 71 starts here. This
comparison made no iTunes request and accessed no iTunes runtime database.

## Safety

Only the committed 25 artists were eligible for contact. No remaining watchlist artist or other
provider was contacted. Apple remained persistently disabled. No pagination, detail lookup,
artwork, preview, personal library, playback, playlist, feed, scheduler, or production mutation
occurred. The lease was released and no cooldown was created. Reports contain no Apple catalog
identifier, complete request URL, token, authorization header, raw response, raw error, or
private-key information.
