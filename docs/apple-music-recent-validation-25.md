# Apple Music Recent Validation, 25 Artists

Date: 2026-07-31

## Decision

The 13-artist mapping-only bootstrap completed. The independent call-graph finding was confirmed:
the existing
`resolveAppleMusicArtistFromCatalogEvidence` scorer previously had no production caller, and
neither the recent cold-start path nor the prior plan-only bootstrap invoked it. Both authorized
identity paths now adapt first-page Top Songs into the existing resolver. No score, conflict, or
margin threshold changed.

The live command is separately gated by confirmation
`APPLE_RECENT_MAPPING_BOOTSTRAP_13`. It accepts only the exact ordered 13-artist self-hashed
artifact and frozen snapshot. It plans five public artist-ID lookups plus sixteen first-page Top
Songs requests, for 21 starts under a hard ceiling of 25 and 60 seconds. It permits no Apple artist
search, release discovery, pagination, or retry. The completed run made exactly those 21 starts,
all HTTP 200. All five seeds were confirmed by exact public-ID and canonical-name compatibility.
The eight two-candidate artists remained ambiguous under the unchanged resolver thresholds. Safe
mapping therefore increased from 12 to 17 of 25, or 68.0%, and the historical Apple HTTP-start
total increased from 181 to 202.

The credential-free normalization correction is complete. Replaying only stored Apple evidence
raises full-cohort exact recall from 7 of 21 to 9 of 21, or 42.9%, and mapped-artist exact recall
from 7 of 12 to 9 of 12, or 75.0%. The two deterministic matcher misses are now exact, matcher
misses are zero, and the three remaining mapped-release misses are catalog misses. Mapping remains
12 of 25 because 13 artists still have ambiguous identities.

The result is below the 20-artist lower evaluation indicator. The candidate-evidence strategy
needs another focused correction or manual evidence, while the five-of-five seed validation
supports requesting a separate sanitized full-watchlist public-ID candidate export from the
free-iTunes branch. Apple must independently validate every future seed. Production integration
and merge remain unauthorized.

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

| Artist          | Stratum                 | Mapping          | Truth | Requests | Endpoints | Accepted or review result                                   |
| --------------- | ----------------------- | ---------------- | ----: | -------: | --------- | ----------------------------------------------------------- |
| SVDDEN DEATH    | positive                | search-confirmed |     3 |        4 | R/R/R/R   | `Dissent`, exact; two catalog misses                        |
| ZHU             | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable album                               |
| Alok            | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable EP                                  |
| Don Diablo      | positive                | ambiguous        |     2 |        0 | NA        | two mapping-unevaluable releases                            |
| SISTO           | positive                | ambiguous        |     3 |        0 | NA        | three mapping-unevaluable singles                           |
| Virus Syndicate | positive                | search-confirmed |     2 |        4 | R/R/R/R   | two exact after corrected feature-marker normalization      |
| Dr. Ozi         | positive                | search-confirmed |     2 |        4 | R/R/R/R   | two exact after corrected feature-marker normalization      |
| William Black   | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable single                              |
| YUSSI           | positive                | ambiguous        |     1 |        0 | NA        | one mapping-unevaluable single                              |
| Leotrix         | positive                | search-confirmed |     3 |        4 | R/R/R/R   | two exact; EP representation deduplicated; one catalog miss |
| Babsy.          | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| Bad Chicken!    | negative                | search-confirmed |     0 |        4 | R/404/R/R | no accepted candidate                                       |
| Bad Computer    | negative                | search-confirmed |     0 |        4 | R/404/R/R | one unconfirmed Apple-only candidate                        |
| Apashe          | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                       |
| Andromedik      | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                       |
| GRiZ            | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| Anto            | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| Rueben          | negative                | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| Autograf        | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                       |
| ATLiens         | negative                | search-confirmed |     0 |        4 | R/R/R/R   | no accepted candidate                                       |
| Au5             | identity/catalog stress | search-confirmed |     1 |        4 | R/R/R/R   | `Inverse`, exact                                            |
| 2TD             | identity/catalog stress | search-confirmed |     1 |        4 | R/R/R/R   | `FEELIN`, exact                                             |
| 1991            | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| 12th Planet     | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                |
| 4B              | identity/catalog stress | ambiguous        |     0 |        0 | NA        | no candidate                                                |

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

### Combined, corrected credential-free replay

- Full-cohort recall: 9 of 21, or 42.9%
- Mapped-artist recall: 9 of 12, or 75.0%
- Exact matched releases: 9
- Strong probable: 0
- Ambiguous: 0
- Mapping-caused unevaluable releases: 9
- Matcher-caused misses: 0
- Catalog misses after successful mapping: 3
- Raw Apple-only candidate rows after corrected comparison: 2
- Unconfirmed Apple-only candidates after reconciliation: 1
- Invalid accepted candidates: 0

Feature markers including `Ft.`, `Feat.`, bracketed `feat.`, and `Featuring` now normalize to one
marker while retaining the credited artist. This makes the Virus Syndicate and Dr. Ozi Top Songs
evidence exact without title-specific exceptions. A terminal `EP` is removed only when the
candidate or frozen evidence is typed as an EP. The Leotrix album and song representations now
deduplicate without losing source evidence. The three catalog misses are mapped remix releases
for which no compatible first-page candidate was retrieved.

## Ambiguous identity audit

All 13 outcomes remain `ambiguous` from existing evidence. No isolated Apple album or song rows
exist for these candidates because the live validation correctly stopped before discovery.
Approved free-iTunes artifacts provide catalog-title evidence and a public-ID seed for five
artists, but a seed is not an Apple confirmation. Candidate counts below are exact normalized-name
matches in the retained Apple search evidence. No artist is confirmed by rank, genre, popularity,
or partial similarity.

| Artist        | Exact-name candidates | Public-ID seed | Frozen releases | Existing catalog-title evidence                        | Conflict or ambiguity                                                      | Additional evidence needed                   |
| ------------- | --------------------: | -------------- | --------------: | ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------- |
| ZHU           |                     2 | yes            |               1 | approved offline exact album evidence                  | two same-name Apple identities                                             | one seeded artist lookup                     |
| Alok          |                    15 | no             |               3 | none                                                   | many same-name identities                                                  | first-page evidence for two fixed candidates |
| Don Diablo    |                     2 | yes            |               3 | approved offline target-window evidence                | two same-name identities; offline evidence is not Apple confirmation       | one seeded artist lookup                     |
| SISTO         |                     3 | yes            |               4 | approved offline release and track evidence            | three same-name identities and one credit incompatibility in prior review  | one seeded artist lookup                     |
| William Black |                     2 | yes            |               3 | approved offline historical release and track evidence | two same-name identities and one prior collection-credit incompatibility   | one seeded artist lookup                     |
| YUSSI         |                     2 | yes            |               4 | approved offline historical release and track evidence | two same-name identities and several competing IDs in the offline artifact | one seeded artist lookup                     |
| Babsy.        |                     7 | no             |               0 | none                                                   | no frozen title evidence                                                   | two candidate pages, then manual review      |
| GRiZ          |                     2 | no             |               1 | none                                                   | two same-name identities                                                   | first-page evidence for two fixed candidates |
| Anto          |                    16 | no             |               0 | none                                                   | many same-name identities and no frozen title evidence                     | two candidate pages, then manual review      |
| Rueben        |                     2 | no             |               3 | none                                                   | two same-name identities                                                   | first-page evidence for two fixed candidates |
| 1991          |                    12 | no             |               1 | none                                                   | many same-name identities                                                  | first-page evidence for two fixed candidates |
| 12th Planet   |                     2 | no             |               0 | none                                                   | two same-name identities and no frozen title evidence                      | two candidate pages, then manual review      |
| 4B            |                    13 | no             |               1 | none                                                   | many same-name identities                                                  | first-page evidence for two fixed candidates |

The five seeded artists can become `existing_id_confirmed` only if a future public catalog lookup
returns the seeded ID with an exact canonical name or stored alias. The eight unseeded artists need
catalog overlap evidence and remain ambiguous if the two-candidate limit does not produce a unique
strong result. Babsy., Anto, and 12th Planet are especially likely to remain manual review because
the frozen window contains no release evidence.

## Why existing-ID confirmation was zero

The deterministic validation manifest intentionally contains artist names and strata, not public
catalog IDs. The validation runner constructs every entry with `requiresSearch: true` and does not
import the corrected free-iTunes identity artifact. Its confirmed-mapping lookup remained isolated
to the same frozen snapshot and found no prior durable mapping for these 13 artists. The existing-ID
code path therefore received no `knownId` and was not defective or accidentally bypassed.

The 48% result is a cold-start name-search stress test. It is not the intended recurring onboarding
workflow, where approved candidate seeds are validated once and confirmed mappings are reused.

## Mapping-only bootstrap plan

The tracked, credential-free artifact is
`apps/scanner/src/apple-music-identity-bootstrap.json`. Its SHA-256 self-check covers the snapshot
hash, evidence date, all 13 canonical names, five public-ID seeds, candidate counts, frozen-release
counts, and the fixed two-candidate shortlists. Public catalog IDs remain excluded from this report.

Plan command:

```powershell
pnpm apple:recent -- --plan --mapping-bootstrap --snapshot <external-snapshot-path> --identity-seeds apps/scanner/src/apple-music-identity-bootstrap.json
```

The verified plan has zero requests, writes, credential access, token generation, or database
access. The separately gated live implementation makes five
`/v1/catalog/us/artists/<seed_id>` confirmation requests and 16
`/v1/catalog/us/artists/<candidate_id>/view/top-songs` first-page evidence requests, one for each
of two fixed candidates across eight artists. It uses the US storefront, no optional query, no
pagination, no search, no retry, concurrency one, and the existing 1,100 ms request-start
interval. It would stop on authentication failure, throttling, unsafe response navigation, budget
or runtime exhaustion, and retain manual review for non-unique evidence. The conservative maximum
is 21 starts and the proposed ceiling is 25 starts with a 60-second runtime ceiling. The minimum
start-to-start time is 22 seconds. No artist requires zero additional requests, and the
four-source release discovery profile must not execute.

## Mapping-only bootstrap result

The run completed in 24,383 milliseconds. Minimum measured request-start spacing was 1,103
milliseconds and maximum concurrency was one. It made five `artist` and sixteen `artist_view`
starts. All 21 returned HTTP 200. There were zero retries, pagination requests, cache hits,
release-discovery operations, searches, catalog-row writes, comparison writes, or recent-candidate
writes. The lease was released, the queue is empty, no cooldown exists, and
`APPLE_MUSIC_ENABLED=false`.

Candidate A and B identify artifact order only. Numeric catalog IDs are intentionally excluded.

| Artist        | Path               | Requests | Existing-ID result | Candidates | Scores | Release overlaps | Track overlaps | Conflicts | Gap | Final classification  | Durable | Manual review |
| ------------- | ------------------ | -------: | ------------------ | ---------: | ------ | ---------------- | -------------- | --------- | --: | --------------------- | ------- | ------------- |
| ZHU           | seeded ID          |        1 | confirmed          |          1 | NA     | NA               | NA             | NA        |  NA | existing_id_confirmed | yes     | no            |
| Alok          | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |
| Don Diablo    | seeded ID          |        1 | confirmed          |          1 | NA     | NA               | NA             | NA        |  NA | existing_id_confirmed | yes     | no            |
| SISTO         | seeded ID          |        1 | confirmed          |          1 | NA     | NA               | NA             | NA        |  NA | existing_id_confirmed | yes     | no            |
| William Black | seeded ID          |        1 | confirmed          |          1 | NA     | NA               | NA             | NA        |  NA | existing_id_confirmed | yes     | no            |
| YUSSI         | seeded ID          |        1 | confirmed          |          1 | NA     | NA               | NA             | NA        |  NA | existing_id_confirmed | yes     | no            |
| Babsy.        | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |
| GRiZ          | candidate evidence |        2 | not applicable     |          2 | 0 / 1  | 0 / 0            | 0 / 1          | 0 / 0     |   1 | ambiguous             | no      | yes           |
| Anto          | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |
| Rueben        | candidate evidence |        2 | not applicable     |          2 | 2 / 0  | 0 / 0            | 5 / 0          | 0 / 0     |   2 | ambiguous             | no      | yes           |
| 1991          | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |
| 12th Planet   | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |
| 4B            | candidate evidence |        2 | not applicable     |          2 | 0 / 0  | 0 / 0            | 0 / 0          | 0 / 0     |   0 | ambiguous             | no      | yes           |

The aggregate result is five seeded confirmations, zero seeded ambiguity or rejection, zero
catalog-evidence confirmations, eight ambiguous identities, and eight manual reviews. Rueben's
five exact track-title overlaps score two because track evidence is intentionally capped at two;
the total remains below the required score of three. GRiZ scores one. Every other candidate scores
zero. No candidate has a release-title overlap or conflict.

## Negative cohort

All ten negative artists had zero frozen in-scope releases. Nine produced no accepted candidate.
Bad Computer produced one unconfirmed Apple-only candidate, so the post-reconciliation review
burden is one candidate across ten negative artists. There were no invalid accepted candidates.

## Source contribution

| Source       | Requests | Unique exact releases | Duplicated exact releases | Raw Apple-only rows | Invalid |
| ------------ | -------: | --------------------: | ------------------------: | ------------------: | ------: |
| Singles      |       12 |                     4 |                         1 |                   2 |       0 |
| Full albums  |       12 |                     0 |                         0 |                   0 |       0 |
| Top Songs    |       12 |                     3 |                         1 |                   1 |       0 |
| Remix search |       12 |                     1 |                         0 |                   0 |       0 |

Top Songs added one unique exact primary release and the two feature-credit remix matches recovered
by corrected normalization.

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
| Full-cohort recall    |                9/21, 42.9% |        8/21, 38.1% |
| Mapped release recall |                9/12, 75.0% |        8/14, 57.1% |
| Primary recall        |                5/13, 38.5% |        7/13, 53.8% |
| Remix recall          |                 4/8, 50.0% |         1/8, 12.5% |

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
