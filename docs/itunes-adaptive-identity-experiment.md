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
