# Apple Music Identity Stage B, Phase 1

Date: 2026-08-04

## Result and boundary

This credential-free checkpoint strengthened the existing identity resolver and replayed all 272
ambiguous seed entries using only approved local evidence. It made no Apple or other-provider
request, read no credential or private key, generated no token, and wrote no development-database
row. The 320 durable mappings remain unchanged. A later, separately authorized milestone now
permits one bounded Phase 2 candidate-evidence run for the six replay-eligible artists after a
committed and pushed credential-free checkpoint. Production integration and merge remain
unauthorized. Persistent `APPLE_MUSIC_ENABLED=false` remains required.

The replay produced zero offline automatic resolutions. Six artists have usable approved watched
release and track history but no cached candidate catalog metadata. The other 266 ambiguous artists
lack usable watched-artist history in the approved local sources. The candidate-free artist remains
manual review. Synthetic tests prove the new code-evidence behavior but are not counted as real
resolutions.

## Resolver and evidence audit

- `resolveColdStartAppleMusicMapping` had an exact-two guard. It now accepts every compatible
  candidate supplied by the immutable artifact.
- `resolveAppleMusicArtistFromCatalogEvidence` already accepted and deterministically ranked an
  arbitrary candidate array. It compares the winner with the actual second-ranked candidate.
- Existing title fallback remains unchanged: three points per exact release-title overlap, up to
  two points from exact track-title overlaps, a minimum score of three, a minimum margin of two,
  and date-conflict rejection.
- Durable mappings are read before cold-start evidence. Persistence is insert-only by canonical
  artist, so an ambiguous result, failed replay, later artifact, or different automatic candidate
  cannot replace a durable mapping. A manual confirmation stored for an unresolved artist remains
  ahead of later automatic evidence and cannot be replaced.
- Search rank, genre, popularity, and artifact order are not identity evidence.

### Apple normalized field paths

- ISRC: song response `attributes.isrc` to the provider schema, sanitized response cache,
  `normalizeSong`, `AppleMusicSong.isrc`, `AppleMusicSongCandidate.isrc`, then the shared evidence
  resolver.
- Parent album title: song response `attributes.albumName` to `AppleMusicSong.albumName`, then the
  derived album candidate and `AppleMusicSongCandidate.albumTitle` used for release-title evidence.
- Song date and identity: `attributes.releaseDate` and the artist relationship become
  `releaseDate` and `artistIds` before resolution.
- UPC: album response `attributes.upc` to the provider schema, sanitized response cache,
  `normalizeAlbum`, `AppleMusicAlbum.upc`, `AppleMusicAlbumCandidate.upc`, then the shared resolver.
- Album title, date, and identity remain `title`, `releaseDate`, and `artistIds`. Apple relationship
  identities are retained, but the normalized type does not separately label one relationship ID
  as primary.

The approved frozen Spotify snapshot retains release titles, release dates, track titles, and track
metadata for its bounded cohort, but its normalized identity-ground-truth type previously had no
ISRC or UPC fields. The type and adapter can now carry them when an approved source provides them.
Neither the current snapshot nor the tracked sanitized iTunes evidence provides code values. The
tracked seed artifact contains aggregate overlap counts, not the underlying titles, dates, ISRCs,
or UPCs, so those counts are not fabricated into ground truth.

## ISRC and UPC policy

ISRC is trimmed, uppercased, stripped using the existing identifier convention, and accepted for
identity only when it has the valid 12-character form. UPC is trimmed and accepted only as an
8-to-14-digit code. Missing or invalid codes are `no_signal` and never a conflict.

A code can confirm only one canonical-name or approved-alias-compatible candidate when exactly one
candidate matches approved watched-artist ground truth. The same matching code on multiple
candidates is `duplicated` and nondecisive. Unrelated codes elsewhere in a candidate catalog are
neutral. Same-title, compatible-date contradictory codes block automatic confirmation. If unique
ISRC and UPC evidence identify different candidates, the result is conflicting and remains manual
review. Evidence records its type, exact, duplicated, missing, or conflicting state, approved
source, and cutoff.

## Approved offline evidence and coverage

The deterministic adapter uses the immutable seed artifact, the approved frozen Spotify snapshot
already imported into the isolated Apple database, approved aliases, and existing sanitized Apple
database and cache rows. The tracked sanitized iTunes reports were audited, but they add no ISRC or
UPC values and are not duplicated into the adapter. No Spotify or iTunes runtime database was read.

Coverage across the 272 ambiguous artists is:

| Evidence                                              | Artists |
| ----------------------------------------------------- | ------: |
| One or more release titles and dates                  |       6 |
| One or more track titles                              |       6 |
| One or more ISRCs                                     |       0 |
| One or more UPCs                                      |       0 |
| Complete candidate catalogs plus watched ground truth |       0 |
| Missing at least one candidate catalog                |     272 |
| Missing usable watched-artist ground truth            |     266 |
| Likely manual review without live candidate retrieval |     266 |

None of the 1,340 ambiguous candidate IDs has reusable candidate catalog metadata in the current
sanitized Apple cache. Therefore ISRC, UPC, and N-candidate support change no real stored outcome at
this checkpoint.

## Credential-free replay

The repository-native command is:

```powershell
pnpm apple:identity-seeds -- --plan --stage-b-evidence-replay --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

It reads only the isolated Apple database, makes no database write, initializes no provider client,
and writes two ignored local review artifacts. The replay classifications are:

| Classification                                         | Artists |
| ------------------------------------------------------ | ------: |
| `offline_auto_resolvable`                              |       0 |
| `requires_live_candidate_evidence`                     |       6 |
| `insufficient_watched_artist_ground_truth`             |     266 |
| `conflicting_identity_evidence`                        |       0 |
| `manual_review_likely` after complete offline evidence |       0 |
| `candidate_free_manual_review`                         |       1 |

The largest bottleneck is watched-artist ground-truth coverage, followed by missing candidate
catalog metadata for the six artists that do have ground truth.

## Cadence-ranked assisted review

Cadence uses only dated approved snapshot releases relative to the evidence cutoff:

- 8 points for each release within 90 days
- 4 points for each release from 91 through 180 days
- 2 points for each release from 181 through 365 days
- 1 point for each older release
- stable normalized artist name and watched-artist ID as tie-breakers

Six unresolved artists have dated history, covering 12 releases, all within 90 days. The other 267
review entries are explicitly `unavailable`, with no invented cadence. This is incomplete cohort
history rather than a representative cadence model.

Ignored local outputs:

- `.app-runtime/apple-music-stage-b-review.json`
- `.app-runtime/apple-music-stage-b-review.html`

The HTML ranks high-cadence entries first, shows bounded candidate links and evidence, and records
confirm, reject, or defer choices. It only downloads a decision artifact and does not apply it.

The strict decision artifact is schema version 1. It binds decisions to the review artifact hash,
requires a watched artist, decision timestamp, decision type, and a bounded candidate for confirm
or reject, permits an optional evidence note, rejects duplicate or out-of-scope artists and
candidates, and validates its own hash. No real decision was applied.

## Bounded Phase 2 live gate

An exhaustive batch lookup for all 1,340 candidate IDs would require 54 artist-batch requests at
the provider's supported maximum of 25 IDs. Current evidence shows that this would not make 266
artists automatically distinguishable, so the proposed live work skips their 1,301 candidates.

The exact evidence-targeted scope is one six-artist batch: Alok, REAPER, Rueben, 1991, 4B, and
GRiZ. It contains 39 bounded candidate IDs. The maximum is:

- 2 multiple-artist lookup requests
- 39 Top Songs first-page requests
- up to 39 Singles first-page fallback requests
- 8 retry and safety requests
- 88 requests total
- 180,000 milliseconds total
- concurrency one and a proposed minimum 1,100-millisecond start interval, which is a local safety
  rule and not a claimed Apple allowance
- no search, pagination, release discovery, detail lookup, or other provider

The credential-free plan is:

```powershell
pnpm apple:identity-seeds -- --plan --stage-b-candidate-evidence --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

The separately confirmed live form is:

```powershell
pnpm apple:identity-seeds -- --execute-live --confirm-live APPLE_IDENTITY_STAGE_B_EVIDENCE_6 --stage-b-candidate-evidence --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

The command validates all candidate identities in two maximum-25 batch lookups, fetches one
minimal Top Songs first page for each compatible candidate, and runs the existing resolver. It
fetches a minimal Singles first page only for unresolved artists whose approved release-title
evidence can still distinguish at least two compatible candidates. It never searches, runs
release discovery, or follows pagination. HTTP 400 and 404 are candidate-local and nonretryable;
HTTP 401, 403, and 429, unsafe navigation, response identity defects, isolation defects, and
budget exhaustion stop the run. The minimum expected manual-review count is 267 and the maximum
is 273, depending on whether the six evidence-targeted artists resolve.

## Safety evidence

Historical Apple HTTP starts were 234 before and after the replay. Durable mappings remained 320.
No active provider state was created, no schema changed, no provider or production state was
contacted, and no credential, private-key information, raw response, complete request URL, or
numeric candidate ID is included in this document.
