# Provider Registration

Verified: 2026-07-16

## Spotify

Create one Spotify Development Mode application using the existing Premium account. New Development Mode applications are limited by Spotify's current app and user rules. Register this exact local redirect URI:

`http://127.0.0.1:3000/api/auth/spotify/callback`

Do not register localhost. Configure `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, and a base64 32-byte `APP_ENCRYPTION_KEY`. The application requests only:

- `user-follow-read` to import followed artists.
- `playlist-read-private` to list and inspect owned private playlists.
- `playlist-modify-private` to create and add items to the Release Inbox playlist.

Official references: [Development Mode migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide), [redirect URIs](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri), [Authorization Code](https://developer.spotify.com/documentation/web-api/tutorials/code-flow), and [PKCE](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow).

## MusicBrainz

No registration, API key, or paid account is required for public non-commercial reads. Set `MUSICBRAINZ_CONTACT_EMAIL` to a monitored address. The client identifies itself as `ReleaseInbox/<version> (<contact>)` and serializes requests to one per second.

## Reddit

Do not enable Reddit before receiving explicit Data API approval. Reddit determines whether access is free or paid. If payment is required, this project will not use the provider. After approved access is received, configure the approved client ID, client secret, and a descriptive User-Agent in the form `platform:application:version (by /u/contact)`, then set both `REDDIT_ENABLED=true` and `REDDIT_ACCESS_APPROVED=true`. The approval flag is an owner record, not proof from Reddit.

Official references: [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy), [Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki), and [access process](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data).

## Deferred Providers

Do not register YouTube, SoundCloud API, Apple Music, or TIDAL for this milestone. Manual SoundCloud outbound links require no provider registration and are disabled by default. Future SoundCloud Artist Pro work remains deferred because paid API access violates the cost constraint.
