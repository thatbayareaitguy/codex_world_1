# Bounded Adaptive iTunes Identity Experiment

Updated: 2026-07-30

## Purpose

This command executes only the frozen 50-artist adaptive identity manifest. It compares
historical-title targeted album search, individual artist album lookup, and a conservative hybrid
decision. It is an isolated evaluation, not a production provider integration.

The command is:

`pnpm itunes:adaptive-identity:run`

Its modes are `controls`, `canary`, `continue`, `verify`, and `artifact`. Every mode requires the
exact census, historical-evidence, and experiment-manifest paths plus both expected file and
canonical hashes.

## Frozen bounds

- 50 canonical artists.
- 98 operations.
- 19 pre-existing valid cache hits.
- 79 new network requests.
- 73 individual album lookups.
- 25 targeted album searches.
- One request at a time.
- At least 3,200 milliseconds between network request starts.
- At most 15 minutes.
- The canary pauses after at most 15 new request starts.

Only `artist_album_lookup` and `targeted_collection_search` are accepted. Album lookup accepts one
numeric artist ID and `entity=album`. Targeted search accepts only the exact manifest parameters.
The executor has no song, collection-detail, batch, or dynamic fallback method.

## Safety gates

Live execution requires:

- `ITUNES_DISCOVERY_ENABLED=true`;
- explicit `--live`;
- branch `codex/itunes-discovery`;
- the exact pushed execution commit;
- a clean worktree;
- isolated database `127.0.0.1:55433/radar_itunes`;
- all non-iTunes providers disabled;
- no other active run or request lease;
- a network budget exactly equal to 79; and
- exact frozen hashes and operation identities.

The v2 targeted-search identity includes provider, storefront, operation, exact normalized
parameters, provider behavior version, and response-normalization version. Existing album cache
identities remain unchanged.

The targeted request path uses one attempt. Any HTTP error, 429, Retry-After, parse failure,
response-size failure, redirect, pacing failure, overlap, duplicate identity, or operation outside
the manifest stops further work. Cached normalized responses are rejected if they contain raw,
artwork, or preview-shaped fields.

## Decision rules

Search rank and result order are ignored. Targeted search requires a compatible artist credit and
an exact distinctive frozen historical title with compatible version markers. Generic titles,
feature-only evidence, excluded evidence, partial titles, and conflicting version markers preserve
ambiguity.

Album-first evaluation reuses the existing deterministic catalog-evidence resolver. The hybrid
preserves ambiguity when two methods conflict. Incorrect confirmation is treated as worse than an
unresolved identity.

Control labels are generated before live work from
`docs/itunes-pilot-offline-evaluation.json` and the frozen manifest. The external control artifact
contains all 13 prior evidence-confirmed controls and 11 unresolved controls. It is generated twice
and requires identical canonical content.

## Artifacts and database use

Experiment operations use the existing isolated pilot run, request-event, response-cache, and
artist-mapping tables. No migration is required. The result artifact is external to source control,
generated twice, and includes per-operation provenance, per-artist method decisions, control
outcomes, operational integrity, frozen hashes, and final isolated totals.

`ITUNES_DISCOVERY_ENABLED` must be restored to `false` before offline verification and artifact
generation. No command in this workflow accesses the main database or production feed.

## Completed result

Execution commit:
`8b86f0800f3c0e22f8c3e7be56f01e5daf75aab8`

Run:
`be113619-a0c1-42e7-899e-784e47a0ce87`

The canary paused after 16 operations: 15 network requests and one cache hit. All 15 network
operations were album lookups because the first targeted search is operation 31, after 30 planned
new starts. Canary minimum pacing was 3,205 ms. It had no error, retry, 429, Retry-After, duplicate,
overlap, prohibited cache field, or active lease.

The completed run has:

- 50 terminal artist mappings;
- 98 of 98 operations;
- 19 cache hits and 79 new requests;
- 73 album lookups and 25 targeted album searches;
- 299,487 ms observed wall-clock span;
- 3,204 ms minimum network request-start spacing;
- zero retry, HTTP error, 429, Retry-After, parse, size, redirect, host/path, overlap, or
  other-provider failure; and
- zero production feed, playlist, or release-candidate rows.

External control artifact:

`C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-adaptive-identity-control-labels-2026-07-30T02-10-30Z.json`

- Canonical SHA-256:
  `2cfc6a3b4f4c49f7640ac5c0fed0546b73c9d0ce7af4314ffe8c248875d7a877`
- File SHA-256:
  `98ae118aa50382ceb745f0834bf6f9606d5dd0146d95bbd96a932b9429b12633`

External result artifact:

`C:\Users\taysh\AppData\Local\TSNewMusicRadar\pilot-snapshots\itunes-adaptive-identity-experiment-result-2026-07-30T02-10-30Z.json`

- Canonical SHA-256:
  `4ab06cafff833bc74ddf73ef85c6fd89803c909a64c80fe166f0939612b8fd0d`
- File SHA-256:
  `a7e05339a31517e245e36628389eb76084bfb131b94801ab8aef5a4c983ce5cd`

### Accuracy and decision

Only 1 of 13 prior evidence-confirmed controls was reproduced. None was confirmed incorrectly,
and 12 remained unresolved. For the 11 paired controls, targeted search reproduced 0, album-first
reproduced 1, and hybrid reproduced 1. Every method had zero incorrect paired resolution.

Three of 50 artists were deterministically resolved: FREAKY, Jason Ross, and the labeled William
Black control. The other 47 remain ambiguous and require manual review. Conservatively, only a
confirmed identity may reduce the original candidate set. That gives 3 artists with justified
reduction and 14 removed alternatives in total. Unexamined candidates are not eliminated.

The result artifact's raw `candidateSetReduction` field instead subtracts the number of candidates
examined by this bounded manifest from the original search set. It therefore overstates
evidence-based reduction for unresolved artists and must not be used for a scaling decision.

Targeted searches returned one or more IDs outside the original top-10 search candidates for 6 of
25 artists, covering 29 unique IDs. None was uniquely corroborated. All six cases remain ambiguous,
and no known labeled control required an outside-top-10 confirmation.

The cohort brute-force album-plus-song baseline was 362 new requests after 150 pre-experiment
cache hits across 512 operations. The experiment used 79 new requests, a reduction of 283 or
78.18%. Request efficiency passed the 25% criterion, but identity accuracy did not.

The predeclared decision is **stop adaptive iTunes identity work**. Reproduction of 1 of 13 labeled
controls is below the stop threshold of 9, and targeted search produced no correct paired
resolution. This decision does not classify iTunes as a production discovery provider.
