# Security and Local Threat Model

## OAuth and Tokens

Spotify uses server-side Authorization Code flow with S256 PKCE. State and verifier are generated with cryptographic randomness. The database stores only a state hash and an AES-256-GCM encrypted verifier. State expires after ten minutes and is consumed atomically once. A signed HTTP-only SameSite Lax cookie binds the callback; production cookies are Secure.

The client secret, authorization code exchange, access token, and refresh token remain on the server. Access and refresh tokens are encrypted independently with random nonces using a base64-encoded 32-byte `APP_ENCRYPTION_KEY`. Refresh starts before expiry, rotates the refresh token when Spotify supplies one, and marks the account reconnect-required after invalid grant or authorization failure. Stable Spotify `account_id` links the account.

Requested scopes are `user-follow-read`, `playlist-read-private`, and `playlist-modify-private`. No email, playback, streaming, public playlist, history, or library-write scope is requested.

## Web and Logging Controls

State-changing routes validate JSON with Zod, enforce same-origin against `APP_BASE_URL`, apply in-memory per-process rate limits, return safe errors, and prevent duplicate writes with database constraints. Logs redact authorization, cookies, tokens, client secrets, passwords, OAuth code, state, and verifier fields. Provider payloads are runtime-validated and full live responses are never logged or committed.

Reddit source mutation routes have the same origin, validation, and rate-limit controls. Reddit network access has a separate hard gate requiring enabled, approval-recorded, complete credential, and valid User-Agent states. Reddit submissions do not persist author, score, comments, votes, media, or HTML. Deleted source text, extracted links, parse rows, evidence, and Reddit-only candidates are purged by reconciliation while independently corroborated canonical records survive without the Reddit association.

Disconnect deletes encrypted Spotify tokens and personal Spotify import history, marks the account disconnected, and preserves the canonical watchlist. Delete all application data requires a separate explicit confirmation and truncates local watchlist, provider, feed, evidence, scan, and export data. It does not remove items already hosted in a Spotify playlist.

## Provider Boundary

No provider playback, preview, embed, widget, artwork transfer, audio request, or mixed queue exists. Spotify payloads are not sent to MusicBrainz. MusicBrainz starts from canonical user-approved names, aliases, and confirmed MBIDs. Spotify does not endorse this application and its broad cross-service policy interpretation remains unresolved.

Manual SoundCloud links are disabled by default. When enabled for development, fields allow only absolute HTTPS SoundCloud domains, reject credentials and unsafe schemes, open with `noopener noreferrer`, and trigger no API, HTML, metadata, artwork, oEmbed, or audio request.

## Threat Model

The local prototype assumes one trusted workstation, an untrusted local network, and potentially malicious provider responses or user input. PostgreSQL binds to loopback, `.env` is ignored, and secrets are not sent to browser JavaScript. Production additionally requires HTTPS, a secrets manager, key rotation, encrypted backups, database TLS, retention policy, and multi-instance rate limiting if more than one web process is deployed.

Operational output hides database credentials and provider secrets. Scanner errors are redacted and truncated before persistence. Backups remain local, may contain encrypted OAuth fields and personal library data, and therefore require filesystem access controls and optional volume encryption. The application never automatically deletes backups.
