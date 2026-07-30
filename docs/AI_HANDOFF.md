# AI Handoff

Updated: 2026-07-29

## Repository state

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Pilot-command starting checkpoint: `f8a3de6331497cd68864db2e42cf32ee8bafe0f8`
- Upstream: `origin/codex/apple-music-discovery`
- Live-checkpoint commit: `7577cca49ad946acfee1fb2e1a480419b97f0191`
- Scope: bounded Apple Music authentication probe and conditional five-artist canary

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
- `pnpm apple:pilot` provides a file-only plan mode and a separately double-confirmed future live
  mode. The production scanner still explicitly rejects the Apple provider. There is no production
  scheduler, feed mutation, UI, or playlist path.
- `--stop-after-canary` binds a live run to 75 requests and 15 minutes, records
  `canary_completed` only after success, and never creates the full-phase client.
- The tracked manifest pins the exact snapshot shape, 25 artists, three known public IDs, BUNT.
  authentication probe, and the deterministic five-artist canary.
- The live controller uses the existing request gate, cache, mapping, catalog, and comparison
  persistence. It adds a run-scoped lease without changing the schema, reuses canary work, batches
  only confirmed IDs, records sanitized terminal evidence, and releases the lease in a finally-safe
  path.

The new focused command/controller suite has 32 passing injected tests. The Apple PostgreSQL file
has 7 passing tests. The real plan command validated the frozen snapshot with credential variables
and database configuration removed, and all isolated Apple database counts remained zero.

The prior campaign-fixture leak did not reproduce in the latest pre-live attempt. One fresh
aggregate run had two Spotify rate-gate timeouts, its focused rerun passed 11 of 11, and the second
fresh aggregate run passed 90 of 90. No Spotify source or test correction was required.

Final command-checkpoint verification passed formatting, zero-warning lint, strict TypeScript, 409
unit tests, 92 aggregate integration tests against a fresh Apple test database, clean and upgrade
migration coverage, no-drift migration generation, production build, 23 mock-only Playwright
tests, and Apple doctor `READY`.

The canary-only checkpoint passed 410 unit tests, 33 focused pilot tests, 7 Apple database tests,
92 canonical aggregate integration tests, formatting, zero-warning lint, strict TypeScript, the
production build, and Apple doctor `READY` with 20 migrations.

## Live authentication evidence

One separately authorized public-catalog artist lookup returned HTTP 200, showing that Apple
accepted the developer credential. Resource URL metadata then failed the existing safe-URL
validation before artist identity confirmation. The controller stopped `failed/unsafe_url` after
one request with zero retries. The canary and full phase did not start.

The run used the canary-only 75-request and 15-minute database limits. The lease was released,
there is no cooldown, and Apple remains persistently disabled. A single parsed-response cache row
created before normalization failed was removed after the audit. Sanitized request telemetry and
the terminal run record remain. No raw response remains.

See `docs/apple-music-api-canary-evaluation.md`.

## Credential and provider boundaries

- Local credentials remain in the ignored runtime file.
- The private key remains outside every repository.
- No identifier, private-key path, token, key content, signature, or authorization header is
  recorded here.
- No additional live Apple request is authorized by this checkpoint.
- No Spotify, iTunes, or other-provider request occurred.
- Music User Tokens, personal libraries, playback, playlists, Apple Music Feed, artwork and
  preview handling, production integration, and merge into `codex/release-radar-hardening` remain
  prohibited.

See `docs/apple-music-api-design.md`, `docs/apple-music-pilot-handoff.md`,
`docs/apple-music-pilot-authorization.md`, `docs/apple-music-runtime.md`, and
`docs/provider-capabilities.md`.

## Next milestone

Reproduce and correct the `unsafe_url` normalization stop with credential-free sanitized fixtures
and official public-catalog URL policy under a new source milestone. Do not retry live
authentication or run the canary without another explicitly bounded authorization. The
five-artist canary and complete 25-artist cohort have not been tested.
