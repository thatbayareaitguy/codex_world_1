# Apple Music Full-Watchlist Identity Mapping

Date: 2026-08-03

## Authorization boundary

This checkpoint imported and validated the immutable 593-artist identity artifact, completed the
one-time resumable Stage A strong-seed campaign, and completed credential-free Stage B Phase 1.
Phase 1 added safe ISRC and UPC evidence, widened the resolver to all bounded artifact candidates,
replayed the 272 ambiguous entries offline, and built ignored assisted-review artifacts. Phase 2
live execution was not performed and is not authorized.

The campaign cannot run recent-release discovery, artist search, pagination, album detail, tracks,
playback, personal-library operations, playlists, Apple Music Feed, or another provider. Persistent
`APPLE_MUSIC_ENABLED=false` is required. Production integration and merge remain unauthorized.

## Immutable input

- Tracked artifact:
  `apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json`
- iTunes worktree checkpoint: `a302c6f0fcd7881da7e901d90379a70ed8644e66`
- Embedded artifact generator commit: `c667bef6b19da4400085c1a9d9c75e446ad19d30`
- Artifact schema: 1
- Artists: 593
- Watchlist hash:
  `6006f18385e161c1acee5340dcb23ac46688f21b14e3b0e1de85e87e4ed586b0`
- Artifact self-hash:
  `0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660`
- Classifications: 307 high-confidence, 13 evidence-supported, 272 ambiguous, one manual
  review, and zero `no_candidate`

Every catalog ID is an unconfirmed candidate until Apple returns that same ID and the returned
artist name is compatible with the canonical name or an approved alias.

The source file is tracked unchanged at the requested iTunes checkpoint. Its embedded generator
commit predates that checkpoint and is retained as immutable provenance rather than rewritten.

## Mapping precedence

1. Immutable durable mapping already confirmed in the Apple database
2. Future manual confirmation
3. High-confidence seed independently validated by Apple
4. Evidence-supported seed independently validated by Apple
5. Unique safe result from the existing catalog-evidence resolver
6. Manual review

The migration backfills the 27 existing confirmed mappings into a canonical-artist-keyed durable
table. Automatic writes use insert-only conflict behavior. A later ambiguous, rejected, or
different candidate cannot replace a durable mapping. Normal pilot and recent-scan identity paths
read the durable mapping before their older snapshot-scoped evidence.

## Stage B Phase 1 result

The credential-free replay evaluated all 272 ambiguous entries and included the candidate-free
entry in final review accounting. It found zero offline automatic resolutions, six artists with
approved release and track history that require live candidate evidence, and 266 artists without
usable watched-artist history in the approved local sources. None of the ambiguous candidate IDs
has reusable catalog metadata in the existing sanitized cache. ISRC and UPC ground-truth coverage
is zero, so code evidence changed no actual result.

The previous exact-two cold-start guard was removed. All bounded artifact candidates, up to the
artifact maximum of ten, now reach the same deterministic resolver. Existing title thresholds,
runner-up comparison, and date-conflict protection remain unchanged.

Details and the nonauthorized Phase 2 proposal are in
`docs/apple-music-identity-stage-b-phase1.md`.

## Credential-free plan

```powershell
pnpm apple:identity-seeds -- --plan --full-watchlist-mapping-bootstrap --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

The Stage B replay command is:

```powershell
pnpm apple:identity-seeds -- --plan --stage-b-evidence-replay --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

The plan reads the vendored artifact and durable mapping rows. It makes zero writes, reads no Apple
credential or private key, generates no token, initializes no HTTP client, and makes zero network
requests.

Pre-live exact Stage A forecast:

- Strong seeds: 320
- Existing strong mappings reused: 27
- Seeds requiring validation: 293
- Batched artist requests: 12
- Batch size: at most 25 IDs
- Request ceiling: 40
- Retry and safety headroom: 28 starts
- Maximum runtime: 10 minutes
- Concurrency: one
- Minimum request-start interval: 1,100 milliseconds
- Minimum pacing span: 12,100 milliseconds

## Stage A live gate

```powershell
pnpm apple:identity-seeds -- --execute-live --confirm-live APPLE_PUBLIC_CATALOG_STRONG_SEEDS_320 --stage strong_seeds --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

Only the multiple-artist public catalog endpoint is reachable. Each response is matched by returned
ID, never array position. An omitted ID remains unresolved. An extra or duplicate returned ID is an
unsafe response and stops the campaign. Name or imported-evidence conflicts block confirmation.
There is no name-search fallback.

The campaign persists artifact hash, stage, resume position, per-artist terminal state, sanitized
evidence, and the immutable durable mapping. HTTP 401, 403, and 429 stop the run. A bounded 5xx retry
may occur within the 40-start ceiling. The lease is released on every terminal path.

## Stage A result

The run reused 27 previously validated strong mappings and submitted the remaining 293 candidates.
Apple returned all 293 requested identities. Exact ID binding, compatible names, and imported
conflict checks confirmed all 293, with no missing, rejected, ambiguous, name-conflict, or
evidence-conflict outcome.

- Newly confirmed high-confidence seeds: 288
- Reused high-confidence mappings: 19
- Newly confirmed evidence-supported seeds: 5
- Reused evidence-supported mappings: 8
- Total strong group durably mapped: 320 of 320
- New Apple starts: 12 batched artist lookups
- HTTP results: 12 HTTP 200
- Runtime: 12,953 milliseconds
- Minimum request-start interval: 1,107 milliseconds
- Concurrency: one
- Retries, searches, pagination, and release discovery: zero
- Sanitized normalized response-cache rows: 12
- Lease: released
- Queue and cooldown: clear
- Historical Apple starts after Stage A: 234

Strong-seed confirmation was 100%. Permanent full-watchlist coverage is 320 of 593, or 54.0%.
The suggested 80% full-watchlist indicator cannot be reached by Stage A alone because the entire
strong group contains only 320 artists. It requires safe Stage B confirmations or manual review.

## Stage B plan only

The remaining ambiguous artifact group has 272 artists and 1,340 bounded alternate candidate IDs.
All 272 have multiple exact-name candidates, no alias match, and no imported title overlap. Artist
lookup alone therefore cannot safely confirm one. Looking up every candidate would require 54
multiple-artist requests at 25 IDs per request, before catalog evidence.

Phase 1 proved that only six ambiguous artists have usable approved watched history. Their 39
bounded candidates form the only evidence-targeted proposed live batch. It would require two
multiple-artist lookup requests, 39 Top Songs first pages, up to 39 Singles fallbacks, and eight
retry and safety requests, for an 88-request and 156,800-millisecond ceiling. The other 1,301
candidate requests are skipped because the current approved ground truth cannot distinguish them.
Expected manual review is 267 to 273 artists. No Phase 2 execution is authorized.

The resolver now accepts all bounded candidates. Its title fallback remains three points for exact
release-title overlap, up to two for track-title overlap, a 30-day date-conflict block, a minimum
score of three, and a minimum winning margin of two. Unique safe ISRC or UPC is a stronger explicit
tier; missing or unrelated codes remain neutral and duplicated or conflicting codes cannot decide.

## Manual review

After Stage A, the report command wrote a 273-artist human-readable queue without numeric catalog
IDs and a local ignored machine-readable queue containing bounded candidate IDs:

```powershell
pnpm apple:identity-seeds -- --report --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json --markdown-output docs/apple-music-full-watchlist-mapping-review.md --local-output .app-runtime/apple-music-full-watchlist-mapping-review.json
```

The report command made zero network requests and read no provider credential. The committed queue
is `docs/apple-music-full-watchlist-mapping-review.md`.
