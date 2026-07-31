# Full-Watchlist iTunes Artist-Search Census

Completed: 2026-07-30

## Decision boundary

The complete search-only census shows that full-watchlist iTunes artist searching is
operationally feasible under the isolated request gate. Search-stage identity coverage is 307 of
593 artists, or 51.8%. The remaining identity burden is substantial but measurable: 1,693
plausible Apple artist IDs would require 3,184 new individual album and song requests after
existing cache reuse. That later work can be divided deterministically into 22 runs of no more
than 150 network requests, with a pacing floor of 2 hours 49 minutes 48.8 seconds.

This result justifies preparing a separately authorized candidate-catalog evidence phase. It does
not authorize that phase, provider production integration, Spotify suppression, or classification
of iTunes as primary, supplemental, rejected, or production-ready.

## Adaptive identity-resolution follow-up

The credential-free adaptive planning milestone is complete. Its detailed record is
`docs/itunes-adaptive-identity-resolution.md`.

- A cutoff-safe historical identity snapshot contains 593 artists, 3,935 historical releases,
  and 623 tracks.
- The strict anchor scorer found 164 artists with usable identity anchors and 429 without them.
- Among the 285 ambiguous artists, 198 have zero usable anchors, 51 have one, and 36 have two or
  more.
- Of the 188 ambiguous artists that reached the 10-result limit, 159 lack strong anchor evidence.
- Album-first retrospective planning estimates 2,595 requests, 589 fewer than the 3,184 baseline.
- The hybrid planning bounds are 373 best case, 2,067 expected under explicit assumptions, and
  2,946 worst case.
- The recommended next bounded test is hybrid targeted search plus adaptive lookup.

The recommendation does not authorize live requests. The correct Apple identity can be outside
the first 10 results, so absence from the census candidate set is never treated as identity
absence.

## Frozen inputs and execution checkpoint

- Branch: `codex/itunes-discovery`
- Starting checkpoint: `bfd305149ab6776bb84a0809009ff3ecc435d5ba`
- Validated pre-live implementation commit:
  `3f83ac4189609f2171a92d4216c0bc3dbd92e140`
- Identity snapshot:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-identity-2026-07-29T06-00-40-741Z.json`
- Snapshot file-byte SHA-256:
  `f555e68c8c16ff78e4cc71e9200b6eddcbd2a7d6dc31f88f4b470d6f50357f23`
- Snapshot canonical-content SHA-256:
  `e9967d5be4b3ddc9d75fcc7e992ea141cccaa2565d314be281ac3d266ea12040`
- Search manifest:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-artist-search-census-plan-2026-07-29T06-00-40-741Z.json`
- Manifest file-byte SHA-256:
  `d808dc6c10d6b1a280abe0aff0d4676360a0c3322a4aa0fa5ffc1ef1441af815`
- Search-behavior fingerprint:
  `1493cc6db2ae9e939ea6ae904f6a2625b760be96feef3a6820151126118cd4a4`

The source remained clean at the exact execution commit from the first request through final
artifact generation. The legacy 50-artist runner blob remained
`ad22a3cb1e1d5b1793a507672cc5ca177b7c93b5`.

## Execution result

All four runs completed. Every run passed the 27-condition verifier.

| Shard | Run ID                                 | Artists | Cache | Network | Runtime ms | Minimum pacing ms |
| ----: | :------------------------------------- | ------: | ----: | ------: | ---------: | ----------------: |
|     1 | `e44e708d-8eff-4c95-a660-6ae3f6448b32` |     150 |    25 |     125 |    398,364 |             3,201 |
|     2 | `a2845562-7c31-44af-86ae-d14cfaf8eff6` |     150 |     5 |     145 |    462,739 |             3,201 |
|     3 | `e6b380fe-23a1-4363-b250-846a0d6d5948` |     150 |    11 |     139 |    443,608 |             3,202 |
|     4 | `0cbb85f2-e2f8-4a09-9cbe-2cb761bdf5d1` |     143 |     9 |     134 |    427,423 |             3,202 |

Every shard had zero retries, HTTP errors, HTTP 429 responses, Retry-After values, parsing errors,
response-size failures, overlaps, redirects, unexpected identities, and other-provider requests.
Every network event was `artist_search` on `/search`. No `/lookup`, batch, album, song, or
collection-detail event occurred.

Final isolated state:

- Census runs: 4, all completed
- Census terminal mappings: 593
- Census events: 593, comprising 50 cache hits and 543 network searches
- Historical plus census request events: 953
- Normalized cache rows: 801
- Active runs: 0
- Active request leases: 0
- Spotify request events: 0
- MusicBrainz request events: 0
- Feed items, playlist exports, and release candidates: 0
- `ITUNES_DISCOVERY_ENABLED=false`

## Search-stage identity result

| State                       | Artists |
| :-------------------------- | ------: |
| Unique exact canonical name |     307 |
| Unique alias supported      |       0 |
| Competing exact or alias    |     285 |
| No exact or alias candidate |       1 |
| Invalid input               |       0 |
| Rejected unsafe result      |       0 |

- Search-stage mapping coverage: 307 of 593, or 51.8%
- Unresolved identity rate: 286 of 593, or 48.2%
- Ambiguous canonical artists: 285
- Total normalized Apple artist candidates: 3,149
- Exact canonical-name candidate IDs: 1,693
- Unique plausible candidate IDs requiring later catalog evidence: 1,693

These are search-stage classifications only. They are not catalog-evidence confirmations.

## Candidate distribution

| Candidates | Artists |
| ---------: | ------: |
|          0 |       0 |
|          1 |     164 |
|          2 |      85 |
|          3 |      35 |
|          4 |      30 |
|          5 |      23 |
|          6 |      11 |
|          7 |       7 |
|          8 |       7 |
|          9 |       6 |
|         10 |     225 |

- Zero candidates: 0
- One candidate: 164
- Two candidates: 85
- Three to five candidates: 88
- Six to nine candidates: 31
- Maximum returned candidate count: 10
- Artists whose declared result count reached the configured limit: 225

The exact 225-artist list is retained in the result artifact under
`analysis.artistsAtResultLimit`. A limit hit is evidence of truncation risk, not catalog
completeness.

Exact canonical-name competitor counts:

| Exact canonical-name IDs | Artists |
| -----------------------: | ------: |
|                        0 |       1 |
|                        1 |     307 |
|                        2 |      83 |
|                        3 |      38 |
|                        4 |      26 |
|                        5 |      30 |
|                        6 |      23 |
|                        7 |      23 |
|                        8 |      20 |
|                        9 |      27 |
|                       10 |      15 |

## Candidate-catalog evidence burden

- Plausible Apple candidate IDs: 1,693
- IDs with existing individual album-cache evidence: 101
- IDs with existing individual song-cache evidence: 101
- New album requests: 1,592
- New song requests: 1,592
- Total new individual requests: 3,184
- Deterministic future runs at no more than 150 requests: 22
- Run sizes: twenty-one runs of 150 and one run of 34
- Pacing floor at 3,200 ms: 10,188,800 ms, or 2:49:48.8

This is a bounded planning result only. No candidate-catalog request was made.

## Original cohort comparison

All 50 original artists were included, and all 50 original artist-search cache rows were reused
without refresh.

- Unique exact canonical: 26
- Competing exact or alias: 24
- Discrepancies from prior search evidence: 0

This comparison does not reuse prior catalog evidence to classify the new search results.

## Result artifact and hash rules

- Complete artifact:
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-search-census-2026-07-30T02-10-30Z.json`
- Final file-byte SHA-256:
  `ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa`
- Embedded preimage file-byte SHA-256:
  `0e32fd1d741e4d3e2124db7d39ce294869ed3f67f6c3b87e7bb02138584f1f20`
- Canonical-content SHA-256:
  `8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d`

The generator built the artifact twice and required byte-identical serialized content and
identical embedded hashes before writing it once.

The canonical hash covers compact JSON before either hash field is added. The embedded
`fileByteSha256` covers indented, newline-terminated JSON before either hash field is added. The
separately reported final file-byte hash covers the exact written file containing both embedded
hash fields. This exclusion is necessary because a file cannot contain its own final cryptographic
hash without a defined exclusion.

## Isolation and limitations

- The ignored runtime file was the only runtime file changed. It was restored to disabled after
  artifact generation.
- The original worktree remained clean on `codex/release-radar-hardening` at
  `7c2b381c0795d1933c13b55914c30900b2a0f63d`.
- No main database, Spotify task, campaign, cooldown, scheduler, provider, feed, playlist, or
  production table was accessed or changed.
- No migration was added.
- `docs/AI_HANDOFF.md` was not changed.
- No merge, rebase, or cherry-pick occurred.
- Existing cache rows do not carry explicit normalizer or provider-client version fields. The
  census records a behavior fingerprint but does not repair that versioning limitation.
- Search-stage coverage does not establish catalog-evidence identity coverage, release discovery
  coverage, release recall, weekly candidate prevalence, Spotify request reduction, or production
  provider classification.

## Final credential-free verification

Verification ran after live enablement was restored to false:

- Formatting: passed
- Lint: passed with zero warnings
- Strict TypeScript: passed across all six packages
- Unit tests: 376 passed in 48 files
- PostgreSQL integration: 85 passed in 16 files against `radar_itunes_test`
- Clean and upgrade migration coverage: passed
- Migration drift: no schema changes and no migration generated
- Production build: passed
- Mocked Playwright: 23 passed
- Credential-free doctor: overall `READY`, with 18 migrations and loopback port 3001 available
- `git diff --check`: passed

No verification command made a provider request.
