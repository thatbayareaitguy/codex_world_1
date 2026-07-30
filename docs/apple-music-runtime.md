# Isolated Apple Music Runtime

## Scope

This runtime supports a disabled-by-default Apple Music public catalog pilot on
`codex/apple-music-discovery`. Apple Developer Program membership is required. A regular Apple
Music listener subscription is not required for public catalog discovery.

The Apple catalog provider and dedicated pilot command are implemented and credential-free tested.
The command is isolated from the production scanner, scheduler, web application, feed, and
playlist flows. Live Apple requests, production scheduling, production integration, Music User
Tokens, personal-library access, playback, playlists, and Apple Music Feed remain prohibited until
a separately authorized milestone.

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

## Pilot command

Plan mode validates the immutable snapshot and pinned cohort without loading the runtime file,
opening a database connection, initializing the developer-token manager, reading a private key, or
creating an HTTP transport:

```powershell
pnpm apple:pilot -- --plan --snapshot <external-snapshot-path>
```

The implemented future live form is:

```powershell
pnpm apple:pilot -- --execute-live --confirm-live APPLE_PUBLIC_CATALOG_25 --snapshot <external-snapshot-path>
```

An explicitly authorized authentication and five-artist canary can stop before the full cohort:

```powershell
pnpm apple:pilot -- --execute-live --confirm-live APPLE_PUBLIC_CATALOG_25 --stop-after-canary --snapshot <external-snapshot-path>
```

Live execution requires both the `--execute-live` flag and the exact independent confirmation
value. It also requires the persistent runtime value `APPLE_MUSIC_ENABLED=false`. The command
creates an in-memory pilot authorization and never rewrites the runtime file or changes that
persistent value.

The controller is limited to the US public catalog, 225 request starts and 45 minutes for the
complete run, 75 request starts and 15 minutes through the canary, concurrency one, and at least
1,100 milliseconds between request starts. `--stop-after-canary` binds the database run itself to
the 75-request and 15-minute ceilings, records `canary_completed`, releases the lease, and never
creates the full-phase client. The real plan command was executed credential-free.

## URL and cache correction

The prior bounded authentication request returned HTTP 200, but response navigation metadata was
handled as if every URL-like field could become a request target. The retained evidence does not
permit recovery of the exact value or field. The code path rules out the descriptive artist
sharing `url`; a non-followed artist albums relationship `href` is the strongest exact-field
match.

The client now distinguishes strict request and pagination URLs from descriptive catalog
metadata. API targets, followed resource paths, and `next` links retain the exact-host, HTTPS,
US-catalog, no-`/v1/me`, no-cross-host, and duplicate-page protections. Descriptive sharing URLs,
non-followed relationship links, and unknown fields are discarded and never transported or
persisted. Cache persistence occurs only after schema checks, navigation checks, and complete
normalization succeed.

Credential-free unit and isolated PostgreSQL tests cover the corrected HTTP 200 sequence and
unsafe pagination failure. This correction made no live Apple or other-provider request.
`APPLE_MUSIC_ENABLED=false` remains required. The next live step is a separately authorized
authentication recheck and five-artist canary retry.

## Execution-owned pagination

The second bounded authentication lookup returned HTTP 200 and stopped on
`relationships.albums.next`. That cursor belonged to an albums relationship embedded in the
artist identity response. The pilot never follows that relationship. It requests each of the six
approved artist views directly, so the embedded relationship navigation is unnecessary.

Embedded relationship and resource navigation is now discarded without becoming a request
target. Only the explicit artist-view and album-track loops own pagination. Their cursors must
match the operation, US storefront, route family, originating resource identity, and originating
view where applicable. Cross-host, cross-operation, cross-identity, unsupported-query, user,
library, unknown-resource, redirect, and duplicate-page paths remain blocked.

Credential-free injected HTTP and isolated PostgreSQL tests reproduce the second response shape,
complete identity normalization, discard all embedded navigation, and write one sanitized cache
row only after success. This correction made no live request. The real Apple request-event count
remains two, and a retry of the same five-artist canary requires separate authorization.
