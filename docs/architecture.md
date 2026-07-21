# Architecture

## MusicBrainz execution boundary

Every MusicBrainz caller uses one PostgreSQL-backed lease in `musicbrainz_provider_state`.
The lease enforces a minimum of 1000 ms between request starts across the web process,
scanner process, retries, and live validation tools. Safe request telemetry is stored in
`musicbrainz_request_events`; contact details and response payloads are not stored there.

Discovery runs as persisted artist batches. Each artist advances through release groups,
primary releases, and track-level appearances. Candidates are committed after each completed
stage, and the operation-lock heartbeat exposes the current stage and most recent persistence
checkpoint. A cancelled batch retains prior candidates and can be resumed from incomplete artists.

MusicBrainz consumes canonical artist names, aliases, and confirmed MBIDs. It does not consume
raw Spotify response metadata. Spotify cooldown state and MusicBrainz state are independent.

## Runtime

- `apps/web`: Next.js UI and server-only OAuth, import, mapping, Reddit source, status, and playlist routes.
- `apps/scanner`: Node.js command for manual, scheduled, filtered, dry-run, backfill, and full scans.
- `packages/core`: provider-neutral types, normalization, matching, logging, and URL safety.
- `packages/db`: Drizzle schema, forward migrations, repositories, OAuth state, token manager, Reddit evidence persistence, scan locks, and operation locks.
- `packages/providers`: runtime-validated Spotify, MusicBrainz, and approval-gated Reddit clients; deterministic Reddit parsing; adapters; import and playlist planners; and MockProvider.
- PostgreSQL: canonical records, provider records, evidence, decisions, cursors, locks, runs, and exports.

Drizzle is used because it keeps the schema and SQL migrations explicit, has a small runtime surface, and permits conflict-safe PostgreSQL writes without generating a separate client.

## Data Flow

1. A user manually creates a canonical artist or explicitly approves a Spotify import preview.
2. Provider IDs are attached to that canonical artist with provenance, confidence, and confirmation state.
3. The scanner loads only confirmed mappings and invokes providers independently.
4. Typed provider candidates are matched to canonical tracks.
5. A transaction preserves provider IDs, source evidence, upcoming history, feed state, availability, and match reasons.
6. Spotify playlist planning selects only exact or manually confirmed Spotify tracks and compares them with current playlist items. Writes default off. When explicitly enabled, route and client guards allow additions only to the server-configured owned private playlist and record them in the export ledger.
7. Reddit text is parsed locally, matched only against the canonical watchlist, and enters review unless exact canonical artist and title are corroborated by existing Spotify availability. Reddit content is never sent to AI.

Spotify responses are never submitted to MusicBrainz. MusicBrainz mapping starts from canonical names, user aliases, and confirmed decisions. Canonical display data is provider-neutral; source-specific values remain in external-ID provider fields and evidence records.

The browser cannot supply or select a Spotify write target. `SPOTIFY_ALLOWED_PLAYLIST_ID` is the only target authority. Playlist creation, rename, visibility changes, artwork, follow, unfollow, removal, replacement, and reordering are outside the provider-client surface.

## Resilience

Provider clients have timeouts, bounded retries, structured errors, pagination, and rate-limit handling. Every Spotify Web API and token request uses one PostgreSQL-backed client-ID queue with a single lease, a five-second minimum start interval, safe request events, and a persistent global cooldown. A Spotify 429 is not retried. MusicBrainz uses one shared serial request gate. Reddit uses its own global request gate and cannot instantiate without recorded approval. Provider failures are isolated.

One global operation lock serializes normal and provider-specific scans. Provider locks still guard persistence. Expired locks are visible through `scan:status` and only stale locks can be cleared. Detailed scan errors and metrics expire while aggregate history remains.

The local application lifecycle is intentionally simple: Docker Compose runs PostgreSQL, `app:up` migrates before binding Next.js to loopback, and external Task Scheduler or cron runs scans. PostgreSQL custom-format backups are stored outside the repository and restore requires explicit replacement confirmation.

The scheduled strategy uses persisted 15-artist batches. Daily discovery checks page one and is distributed over 24 hours. Initial backfill and periodic reconciliation use bounded two-page work units and resume from the next unresolved Spotify offset across runs. A new reconciliation cycle resets to page one only when explicitly requested or when the configured cycle has expired. Provider ordering is not treated as an updated-since guarantee.

Spotify catalog coverage is separate from canonical music data. `spotify_artist_coverage` stores the current cycle, next offset, status, page counts, and reconciliation timestamps. `spotify_page_scans` retains page-level operational history. `spotify_catalog_releases` retains validated provider summaries so old or unchanged releases do not require full album requests and do not create feed records. The artist becomes fully reconciled only after Spotify omits the next-page cursor.

All scan modes share the global operation lock, the PostgreSQL Spotify request gate, and the configured request budget. A budget stop is paused work, not a provider failure. Completed pages and their next cursor remain committed, and a later process resumes the same artist. A 429 still stops all Spotify activity and persists the provider cooldown.
