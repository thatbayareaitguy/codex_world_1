# Isolated Apple Music Runtime

## Scope

This runtime supports a disabled-by-default Apple Music public catalog pilot on
`codex/apple-music-discovery`. Apple Developer Program membership is required. A regular Apple
Music listener subscription is not required for public catalog discovery.

The Apple catalog provider is implemented and credential-free tested, but it is not connected to a
runtime command or production flow. Live Apple requests, production scheduling, production
integration, Music User Tokens, personal-library access, playback, playlists, and Apple Music Feed
remain prohibited.

## Credential Isolation

Local credentials belong only in the ignored `.app-runtime/apple-music.env` file. The `.p8`
private key must remain outside every repository and must never be copied into a worktree.
Developer tokens are generated server-side and must not be logged or persisted. Music User Tokens
are not used.

The tracked `.env.example` contains placeholders only. Never replace those placeholders with real
identifiers or paths.

## Runtime Isolation

- Compose file: `docker-compose.apple.yml`
- Compose project: `codex_world_1_apple`
- Web port: `3002`
- Development database: `radar_apple` on loopback port `55435`
- Test database: `radar_apple_test` on loopback port `55436`
- PostgreSQL application name: `release-radar-apple`
- Development volume: `codex_world_1_apple_radar-apple-postgres`
- Runtime file: `.app-runtime/apple-music.env`

Start only the Apple databases with:

```powershell
docker compose --env-file .app-runtime/apple-music.env -p codex_world_1_apple -f docker-compose.apple.yml up -d db db-test
```

The Apple environment does not reuse Spotify or iTunes containers, volumes, database names, ports,
or runtime files. Apple Music remains disabled until a separate milestone authorizes bounded live
access.
