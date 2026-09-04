# Deployment

Deploy one Next.js process, one PostgreSQL database, and one scheduled invocation of the scanner command. This remains a private, single-user, non-commercial application.

## Release Procedure

1. Run all lint, type, unit, database, build, browser, and diff checks.
2. Back up PostgreSQL and apply forward-only migrations once.
3. Supply secrets through the hosting platform, never the image or repository.
4. Use an HTTPS `APP_BASE_URL` and matching Spotify redirect URI.
5. Run a Spotify or Apple Music dry run, then enable only the intended incremental schedule. Keep
   `MUSICBRAINZ_ENABLED=false` in normal production.
6. Schedule a less frequent explicit `--full` reconciliation.
7. Monitor failed or stale scan runs without logging provider payloads or tokens.

Production cookies are secure, HTTP-only, and SameSite Lax for the OAuth callback. PostgreSQL should use TLS, backups, a restricted role, and point-in-time recovery. Keep one active scanner execution; the database lock rejects overlap and expires after interruption.

Spotify policy compatibility is not represented as approved. No playback, previews, embeds, public signup, advertising, or commercial functionality may be deployed.
