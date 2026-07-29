# AI Handoff

Updated: 2026-07-29

## Repository State

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Runtime milestone starting checkpoint: `98a44cf663f73e169ad93d1567aae4562092a053`
- Upstream: `origin/codex/apple-music-discovery`
- Scope: isolated runtime and local credential readiness only

## Runtime

- Compose project: `codex_world_1_apple`
- Compose file: `docker-compose.apple.yml`
- Web port: `3002`, available on loopback
- Development database: `radar_apple` on loopback port `55435`
- Test database: `radar_apple_test` on loopback port `55436`
- PostgreSQL application name: `release-radar-apple`
- Dedicated development volume: `codex_world_1_apple_radar-apple-postgres`
- Test storage: isolated container tmpfs
- Applied migrations: 18 in each Apple database
- Repository doctor: `READY`

The Apple containers, network, volume, database names, and ports are separate from Spotify and
iTunes.

## Credentials

- Ignored runtime file: `.app-runtime/apple-music.env`
- Apple Music remains disabled
- Team ID, Key ID, and Media ID are configured locally but are not recorded here
- The private key remains outside all repositories
- Local validation confirmed a readable PEM EC private key compatible with ES256 and P-256
- One short-lived developer token was generated and validated only in memory, then discarded
- No token, identifier, private-key path, private-key material, or signature was logged or persisted

## Boundaries

- Apple provider implementation has not started
- No Apple, Spotify, iTunes, or other live-provider request occurred
- Music User Tokens, personal-library access, playback, playlists, and Apple Music Feed remain
  prohibited
- Production scheduling, production integration, and merging into
  `codex/release-radar-hardening` remain unauthorized
- The Spotify and iTunes worktrees, databases, tasks, and runtime environments were not modified

See `docs/apple-music-pilot-authorization.md` and `docs/apple-music-runtime.md`.
