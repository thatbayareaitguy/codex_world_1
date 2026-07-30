# AI Handoff

Updated: 2026-07-29

## Repository state

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Implementation starting checkpoint: `905838657fe014cbc50a81c12ef6c43702e466d6`
- Upstream: `origin/codex/apple-music-discovery`
- Scope: credential-free Apple Music catalog provider implementation

## Runtime isolation

- Compose project: `codex_world_1_apple`
- Compose file: `docker-compose.apple.yml`
- Web port: `3002`
- Development database: `radar_apple` on loopback port `55435`
- Test database: `radar_apple_test` on loopback port `55436`
- PostgreSQL application name: `release-radar-apple`
- Provider default: disabled

The Apple containers, network, volume, database names, ports, request gate, telemetry, cache,
mappings, and comparison rows are separate from Spotify and free-iTunes runtime state. The frozen
iTunes pilot snapshot is immutable input only.

## Implementation

- `AppleDeveloperTokenManager` generates ES256 developer tokens from an external P-256 key, caches
  them only in memory, and refreshes before expiration.
- `AppleMusicClient` permits only exact-host public catalog GET requests and implements artist
  search, single and maximum-25 artist lookup, six artist views, album lookup, paginated album
  tracks, and song batches.
- Every followed path is relative and allowlisted. Pagination is terminal, duplicate-safe, and
  locally sorted.
- The Apple-only database gate enforces concurrency one, at least 1,100 milliseconds between
  starts, request/runtime budgets, safe telemetry, normalized cache reuse, and persisted 429
  cooldowns.
- Mapping and comparison logic is deterministic, evidence-based, and supports the frozen
  50-artist evaluation model.
- The production scanner explicitly rejects the Apple provider. There is no production command,
  scheduler, feed mutation, UI, or playlist path.

Credential-free verification passed formatting, lint, strict TypeScript, 377 unit tests, 5 Apple
database tests, all 17 integration files independently with 90 tests, production build, 23
mock-only Playwright tests, clean and upgrade migration paths, migration drift, and the
Apple-scoped doctor. The aggregate integration invocation retains an existing order-dependent
Spotify campaign-fixture leak into the scheduler suite; Spotify code and tests were not changed.

## Credential and provider boundaries

- Local credentials remain in the ignored runtime file.
- The private key remains outside every repository.
- No identifier, private-key path, token, key content, signature, or authorization header is
  recorded here.
- No live Apple, Spotify, iTunes, or other-provider request is authorized by this checkpoint.
- Music User Tokens, personal libraries, playback, playlists, Apple Music Feed, artwork and
  preview handling, production integration, and merge into `codex/release-radar-hardening` remain
  prohibited.

See `docs/apple-music-api-design.md`, `docs/apple-music-pilot-handoff.md`,
`docs/apple-music-pilot-authorization.md`, `docs/apple-music-runtime.md`, and
`docs/provider-capabilities.md`.

## Next milestone

The exact next milestone is a separately authorized, bounded 25-artist Apple Music live
completeness test. Do not begin it from this checkpoint.
