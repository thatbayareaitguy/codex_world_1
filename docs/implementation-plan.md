# Spotify and MusicBrainz Milestone Plan

Verified: 2026-07-16

## Preserved Work

Keep the pnpm monorepo, strict TypeScript, Drizzle schema and migration history, canonical watchlist, deterministic matching engine, source evidence, feed states, scanner, MockProvider, manual SoundCloud link records, repaired controls, theme selector, and existing tests.

## Implementation Order

1. Add Docker Compose commands for distinct local and test PostgreSQL databases. Integration tests provision, migrate, and reset the test database or fail with an actionable Docker error. They never skip.
2. Add validated server-only configuration for Spotify, MusicBrainz, the initial backfill window, encryption, and the default-disabled manual SoundCloud feature.
3. Extend the schema with OAuth lifecycle metadata, single-use OAuth state, artist aliases and mapping provenance, provider field evidence, scan locks and metrics, upcoming-date history, and playlist synchronization metadata. Add only forward migrations.
4. Implement authenticated server-side Spotify Authorization Code flow with PKCE, short-lived signed HTTP-only state cookies, encrypted refresh tokens, automatic rotation, redacted structured errors, disconnect, and personal-data deletion.
5. Implement a runtime-validated Spotify client using only current endpoints. Complete cursor and offset pagination, bounded concurrency, timeouts, cancellation, `Retry-After`, token refresh, and structured errors.
6. Add a user-approved followed-artist preview and batched confirmation workflow. Preserve manual canonical names, deduplicate reruns, and route ambiguous names to review.
7. Implement a read-only MusicBrainz client with a contactable User-Agent, one global request per second, bounded 503 retries, artist scoring, release-group and release browse, and `track_artist` appearance browse.
8. Extend scanner arguments and orchestration for enabled providers, artist filters, dry runs, full scans, since dates, backfill windows, provider isolation, scan locking, checkpoints, and idempotent persistence.
9. Extend matching regression coverage and persist algorithm version, reasons, conflicting source values, provider identifiers, release-level relationships, upcoming date history, and review records.
10. Complete the feed, provider settings, watchlist mappings, review queue, scan history, private Spotify playlist preview and synchronization, privacy, terms, disconnect, and deletion controls. Hide manual SoundCloud controls by default.
11. Add synthetic unit, database integration, and Playwright tests. Normal verification never calls Spotify or MusicBrainz.
12. Update all repository documentation, run every required command, inspect the complete diff, and correct migration, interaction, security, and stale-documentation defects.

## Verified Provider Constraints

- Spotify Development Mode requires the app owner to retain Premium. The product requests only `user-follow-read`, `playlist-read-private`, and `playlist-modify-private`.
- Use `GET /me` and stable `account_id`, `GET /me/following`, individual artist, album, and track endpoints, `GET /me/playlists`, `POST /me/playlists`, and playlist `/items` endpoints.
- Do not use removed browse new releases, user playlist routes, bulk track or artist reads, or playlist `/tracks` routes.
- Spotify followed artists use cursor pagination up to 50 per page. Artist albums and search use no more than 10 per page. Playlist item reads use up to 50 and additions use batches up to 100.
- MusicBrainz uses JSON search, release-group browse by confirmed artist MBID, release browse by artist, and release browse by `track_artist` for appearances. Browse pages are at most 100 and release offsets advance by actual result count.
- MusicBrainz requests are serialized at one request per second or slower and use `ReleaseInbox/<version> (<contact>)`.

## Policy Boundary

No playback, previews, embeds, audio handling, cross-provider artwork, Spotify-to-MusicBrainz payload transfer, live response fixtures, AI ingestion, public signup, or commercial behavior is implemented. MusicBrainz starts only from canonical user-approved watchlist data and confirmed mappings. Spotify policy compatibility remains unresolved and is not represented as approved.

## Environment Constraint

Docker is not currently installed on the development machine. The milestone cannot be marked complete until the clean-database migration and non-skipped integration suite run successfully with Docker Compose. The repository commands must report this condition clearly rather than skipping tests.
