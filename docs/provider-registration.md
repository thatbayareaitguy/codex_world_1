# Provider Registration

Verified: 2026-08-04

## Spotify

Create one Spotify Development Mode application using the existing Premium account. New Development Mode applications are limited by Spotify's current app and user rules. Register this exact local redirect URI:

`http://127.0.0.1:3000/api/auth/spotify/callback`

Do not register localhost. Configure `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, and a base64 32-byte `APP_ENCRYPTION_KEY`. Initial authorization requests only:

- `user-follow-read` to import followed artists.
- `playlist-read-private` to preserve read access if the one configured playlist is private during setup.

Keep `SPOTIFY_PLAYLIST_WRITES_ENABLED=false` and `SPOTIFY_ALLOWED_PLAYLIST_ID=` for initial authorization. Create the desired playlist directly in Spotify before enabling the implemented add-only membership export. Set its 22-character ID in `SPOTIFY_ALLOWED_PLAYLIST_ID`, enable writes, and reconnect Spotify with forced consent to grant both `playlist-modify-private` and `playlist-modify-public`. The application has no playlist picker and cannot create or select a playlist. Every live export re-verifies that the configured playlist ID is the returned playlist, is owned by the connected account, and is non-collaborative. The authorized production target is expected to be public. Dry runs and live exports use the same canonical eligibility and release-date ordering plan. Live export adds eligible tracks at their Custom Order position, may use snapshot-aware range moves on existing items, and persists an application-owned ledger and verified snapshot cache for restart safety and idempotency. It never removes or re-adds a track to order it. The only visibility mutation is the internal fixed-target command documented in local development; it sets that authorized playlist public and verifies all playlist invariants.

Use `pnpm spotify:playlist-export -- --dry-run` to inspect the configured target, additions, skips, and ordering without provider mutation. Use `pnpm spotify:playlist-export -- --live` only after the dry run is correct and the write scope is present. Use `pnpm spotify:playlist-order -- --dry-run`, then `--canary`, then `--live` for an explicit existing-playlist Custom Order conversion. Neither command accepts a playlist ID argument.

Official references: [Development Mode migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri), [Authorization Code](https://developer.spotify.com/documentation/web-api/tutorials/code-flow), [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow), and [scopes](https://developer.spotify.com/documentation/web-api/concepts/scopes).

## MusicBrainz

MusicBrainz is dormant and disabled by default. No registration, API key, or paid account is
required for public non-commercial reads, but it is not configured for normal production use.
Advanced re-enable requires `MUSICBRAINZ_ENABLED=true`, a monitored `MUSICBRAINZ_CONTACT_EMAIL`,
and separate validation. The preserved client identifies itself as
`TSNewMusicRadar/<version> (<contact>)` and serializes requests to one per second.

## Apple Music

An active Apple Developer Program membership is required and is an explicitly approved paid
prerequisite. In Certificates, Identifiers & Profiles, create a Media ID with MusicKit enabled,
create a Media Services private key, associate it with that Media ID, and retain the team ID and key
ID. Store the downloaded `.p8` private key outside the repository.

Configure `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_PRIVATE_KEY_PATH`, and
`APPLE_MUSIC_STOREFRONT`, then set `APPLE_MUSIC_ENABLED=true`. The server generates short-lived
developer tokens. Do not create, request, or store a Music User Token because this application uses
only public catalog data.

Official references: [MusicKit](https://developer.apple.com/musickit/),
[media identifier and private key](https://developer.apple.com/help/account/capabilities/create-a-media-identifier-and-private-key),
[user authentication boundary](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit),
and [program membership](https://developer.apple.com/programs/whats-included/).

## Reddit

Do not enable Reddit before receiving explicit Data API approval. Reddit determines whether access is free or paid. If payment is required, this project will not use the provider. After approved access is received, configure the approved client ID, client secret, and a descriptive User-Agent in the form `platform:application:version (by /u/contact)`, then set both `REDDIT_ENABLED=true` and `REDDIT_ACCESS_APPROVED=true`. The approval flag is an owner record, not proof from Reddit.

Official references: [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy), [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki), and [access process](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).

## Deferred Providers

Do not register YouTube, SoundCloud API, or TIDAL for this milestone. Manual SoundCloud outbound links require no provider registration and are disabled by default. Future SoundCloud Artist Pro work remains deferred because paid API access has not been approved.
