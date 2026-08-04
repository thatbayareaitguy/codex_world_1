# Apple Music Full-Watchlist Identity Mapping

Date: 2026-08-03

## Authorization boundary

This checkpoint imports and validates the immutable 593-artist identity artifact and implements a
one-time, resumable mapping campaign. Only Stage A strong-seed validation is authorized for live
execution. Stage B ambiguous automation is planned but not authorized.

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

## Credential-free plan

```powershell
pnpm apple:identity-seeds -- --plan --full-watchlist-mapping-bootstrap --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json
```

The plan reads the vendored artifact and durable mapping rows. It makes zero writes, reads no Apple
credential or private key, generates no token, initializes no HTTP client, and makes zero network
requests.

Current exact Stage A forecast:

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

## Stage B plan only

The remaining ambiguous artifact group has 272 artists and 1,340 bounded alternate candidate IDs.
Candidate resource validation requires 56 batched lookup starts across six groups of at most 50
artists. A conservative evidence ceiling is 544 first-page Top Songs requests and 544 first-page
Singles fallbacks. Pagination and broad artist search remain prohibited.

Stage B cannot be executed by this checkpoint. A later milestone must provide a separately reviewed
request ceiling for each 50-artist batch and confirm that title-level ground truth is sufficient for
the unchanged catalog-evidence resolver. Its scoring remains three points for exact release-title
overlap, up to two for track-title overlap, a 30-day date-conflict block, a minimum score of three,
and a minimum winning margin of two.

## Manual review

After Stage A, the prebuilt report command writes a human-readable document without numeric catalog
IDs and a local ignored machine-readable queue containing bounded candidate IDs:

```powershell
pnpm apple:identity-seeds -- --report --artifact apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json --markdown-output docs/apple-music-full-watchlist-mapping-review.md --local-output .app-runtime/apple-music-full-watchlist-mapping-review.json
```

The report command makes zero network requests and reads no provider credential.
