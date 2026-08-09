# Security and Local Threat Model

## OAuth and Tokens

Spotify uses server-side Authorization Code flow with S256 PKCE. State and verifier are generated with cryptographic randomness. The database stores only a state hash and an AES-256-GCM encrypted verifier. State expires after ten minutes and is consumed atomically once. A signed HTTP-only SameSite Lax cookie binds the callback; production cookies are Secure.

The client secret, authorization code exchange, access token, and refresh token remain on the server. Access and refresh tokens are encrypted independently with random nonces using a base64-encoded 32-byte `APP_ENCRYPTION_KEY`. Refresh starts before expiry, rotates the refresh token when Spotify supplies one, and marks the account reconnect-required after invalid grant or authorization failure. Stable Spotify `account_id` links the account.

Initial authorization requests only `user-follow-read` and `playlist-read-private`. No playlist modification, email, playback, streaming, history, or library-write scope is requested while `SPOTIFY_PLAYLIST_WRITES_ENABLED=false`. When the write gate and one allowed playlist ID are explicitly configured, authorization additionally requests both `playlist-modify-private` and `playlist-modify-public`. The application rejects collaborative, unowned, or non-allowlisted targets. Public and private visibility both pass the general write guard because the authorized production playlist is public.

Spotify has no playlist-specific write scope. The write path therefore has two independent application gates: `SPOTIFY_PLAYLIST_WRITES_ENABLED=true` and the exact `SPOTIFY_ALLOWED_PLAYLIST_ID=4l6LaMPL6duulmFe3hRR4Y`. Configuration rejects every other playlist ID, and the automatic runtime repeats that check before acquiring a lock or constructing a provider client. Routes accept no playlist ID or other write body from the browser, and operational CLIs have no target argument. The route and provider client compare the target with server configuration, retrieve the playlist, and require the connected account to own a non-collaborative playlist before additions or Custom Order maintenance. Only exact or manually confirmed tracks can be added. Durable run and operation rows make interruption recovery and provider readback idempotent without removing user tracks. Ordering uses only snapshot-aware contiguous range moves and verifies membership plus `added_at` afterward. Playlist creation, rename, arbitrary visibility changes, artwork, follow, unfollow, remove, replace, and arbitrary reorder operations are not exposed. The single-purpose visibility command can only set the hard-coded authorized target to public and non-collaborative, and performs full readback invariants. Tokens and full playlist IDs are excluded from logs; write logs use an abbreviated ID.

## Web and Logging Controls

State-changing routes validate JSON with Zod, enforce same-origin against `APP_BASE_URL`, apply in-memory per-process rate limits, return safe errors, and prevent duplicate writes with database constraints. Logs redact authorization, cookies, tokens, client secrets, passwords, OAuth code, state, and verifier fields. Provider payloads are runtime-validated and full live responses are never logged or committed.

Spotify rate-limit telemetry stores endpoint categories rather than URLs containing provider IDs. It may store status, timestamps, queue wait, raw `Retry-After`, parsed duration, cooldown, and redacted response classification. It does not store authorization data or provider payloads. One database-backed cooldown covers OAuth token, scanner, web route, playlist, and explicit live-test request paths and survives process restart.

Apple Music uses a server-generated ES256 developer token derived from the team ID, key ID, and a local Media Services private key path. The private key and generated token never enter browser JavaScript, PostgreSQL, logs, fixtures, or source control. Public catalog requests do not use a Music User Token and cannot access a subscriber library, recommendations, favorites, playback, or playlists. One PostgreSQL-backed gate serializes all Apple requests, enforces at least 1100 ms between starts, persists cooldowns and safe endpoint telemetry, and excludes full URLs, provider payloads, and authorization headers.

Reddit source mutation routes have the same origin, validation, and rate-limit controls. Reddit network access has a separate hard gate requiring enabled, approval-recorded, complete credential, and valid User-Agent states. Reddit submissions do not persist author, score, comments, votes, media, or HTML. Deleted source text, extracted links, parse rows, evidence, and Reddit-only candidates are purged by reconciliation while independently corroborated canonical records survive without the Reddit association.

Disconnect deletes encrypted Spotify tokens and personal Spotify import history, marks the account disconnected, and preserves the canonical watchlist. Delete all application data requires a separate explicit confirmation and truncates local watchlist, provider, feed, evidence, scan, and export data. It does not remove items already hosted in a Spotify playlist.

## Provider Artwork Boundary

No provider playback, preview, embed, widget, artwork transfer, audio request, or mixed queue exists. Spotify-backed and Apple-backed feed items may render official artwork directly from their exact validated provider hosts. The application stores only the URL, dimensions, provider release ID and URL, provider, and last-observed timestamp. It does not download, proxy, cache, rehost, crop, distort, overlay, or transform the image. Every rendered cover links to the matching provider release, uses `noopener noreferrer`, and falls back locally after a load failure.

Spotify artwork must match the strict `i.scdn.co` image path and corresponding `open.spotify.com` album. Apple artwork must be HTTPS on the exact allowed `mzstatic.com` image host and link to a validated `music.apple.com` release. MusicBrainz-only evidence cannot receive Spotify or Apple artwork. Provider payloads are never sent from one provider to another. Spotify does not endorse this application and its broad cross-service policy interpretation remains unresolved.

Historical artwork backfill is bounded to 25 releases per invocation, defaults to dry-run, requires explicit apply mode for writes, and uses only stored Spotify album IDs. It shares the database-backed cooldown and ten-second request gate with every other Spotify path. It has no search or playlist capability and never logs full image URLs or response payloads.

Manual SoundCloud links are disabled by default. When enabled for development, fields allow only absolute HTTPS SoundCloud domains, reject credentials and unsafe schemes, open with `noopener noreferrer`, and trigger no API, HTML, metadata, artwork, oEmbed, or audio request.

## Threat Model

The local prototype assumes one trusted workstation, an untrusted local network, and potentially malicious provider responses or user input. PostgreSQL binds to loopback, `.env` is ignored, and secrets are not sent to browser JavaScript. Production additionally requires HTTPS, a secrets manager, key rotation, encrypted backups, database TLS, retention policy, and multi-instance rate limiting if more than one web process is deployed.

Operational output hides database credentials and provider secrets. Scanner errors are redacted and truncated before persistence. Backups remain local, may contain encrypted OAuth fields and personal library data, and therefore require filesystem access controls and optional volume encryption. The application never automatically deletes backups.
