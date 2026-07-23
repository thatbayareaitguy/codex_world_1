# Architecture

## MusicBrainz execution boundary

Every MusicBrainz caller uses one PostgreSQL-backed lease in `musicbrainz_provider_state`.
The lease enforces a minimum of 1000 ms between request starts across the web process,
scanner process, retries, and live validation tools. Safe request telemetry is stored in
`musicbrainz_request_events`; contact details and response payloads are not stored there.

Discovery runs as persisted artist batches. Each artist advances through release groups,
primary releases, and track-level appearances. Candidates are committed after each completed
stage, and the operation-lock heartbeat exposes the current stage and most recent persistence
checkpoint. A cancelled batch retains prior candidates and resumes at the next incomplete artist.
An interrupted artist restarts from `artist_start`; persisted candidates make repeated completed
stages idempotent, but the current implementation does not resume inside a MusicBrainz stage.

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
4. Typed provider candidates are matched to canonical tracks independently from canonical releases.
5. A transaction preserves provider IDs, source evidence, upcoming history, feed state, availability, match reasons, and the provenance-backed release-to-track appearance.
6. Spotify playlist planning selects only exact or manually confirmed Spotify tracks and compares them with current playlist items. Writes default off. When explicitly enabled, route and client guards allow additions only to the server-configured owned private playlist and record them in the export ledger.
7. Reddit text is parsed locally, matched only against the canonical watchlist, and enters review unless exact canonical artist and title are corroborated by existing Spotify availability. Reddit content is never sent to AI.

Spotify responses are never submitted to MusicBrainz. MusicBrainz mapping starts from canonical names, user aliases, and confirmed decisions. Canonical display data is provider-neutral; source-specific values remain in external-ID provider fields and evidence records.

The browser cannot supply or select a Spotify write target. `SPOTIFY_ALLOWED_PLAYLIST_ID` is the only target authority. Playlist creation, rename, visibility changes, artwork, follow, unfollow, removal, replacement, and reordering are outside the provider-client surface.

## Resilience

Provider clients have timeouts, bounded retries, structured errors, pagination, and rate-limit handling. Every Spotify Web API and token request uses one PostgreSQL-backed client-ID queue with a single lease, a ten-second production minimum start interval, safe request events, and a persistent global cooldown. A Spotify 429 is not retried. MusicBrainz uses one shared serial request gate. Reddit uses its own global request gate and cannot instantiate without recorded approval. Provider failures are isolated.

One global operation lock serializes normal and provider-specific scans. Provider locks still guard persistence. Expired locks are visible through `scan:status` and only stale locks can be cleared. Detailed scan errors and metrics expire while aggregate history remains.

The local application lifecycle is intentionally simple: Docker Compose runs PostgreSQL, `app:up` migrates before binding Next.js to loopback, and external Task Scheduler or cron runs scans. PostgreSQL custom-format backups are stored outside the repository and restore requires explicit replacement confirmation.

The implemented scheduled strategy uses persisted 15-artist batches. Daily discovery checks page one, while initial backfill and periodic reconciliation use bounded work units that resume from the next unresolved Spotify offset. A new reconciliation cycle resets to page one only when explicitly requested or when the configured cycle has expired. Provider ordering is not treated as an updated-since guarantee.

The rolling scheduler in [spotify-rolling-scheduler-design.md](spotify-rolling-scheduler-design.md) is implemented as a short-lived tick backed by `spotify_scheduler_state` and `spotify_scheduler_work`. It uses dynamic 24-hour base due times, deterministic PostgreSQL claims, expiring work leases, the existing `scan:global` operation lock, the existing Spotify request gate and cooldown, and explicit planning, validation, automatic, paused, and disabled modes. Each tick handles at most one artist, six Spotify request starts, and 90 seconds. OAuth refreshes and retries that start a request consume the same budget.

Base checks can defer newly selected release details into typed work. The detail worker reuses the existing candidate persistence, matching, evidence, release-track page, and resume checkpoints. Incomplete track retrievals become repair work, while deeper artist reconciliation is eligible only when due base and urgent release work do not need the slot. Planning constructs no production provider client and performs no durable mutation. Production capability and database mode both default disabled. The scheduler tick and ten-second pacing have bounded live validation, but automatic long-running execution is not yet live verified. Existing manual batches remain available and Batch 3 remains untouched.

### Bounded initial-sync campaigns

Migration `0015_bounded_spotify_campaign.sql` adds a minimal campaign layer without replacing the
rolling scheduler. A campaign snapshots the deterministic set of active, confirmed Spotify-mapped
artists that have no successful coverage. A row lock on the campaign serializes claims, and a base
claim reserves one qualifying slot in the same transaction that leases its scheduler work. A first
successful coverage transition converts that reservation exactly once. Failed, expired, skipped,
or externally completed members release or avoid the reservation.

The campaign enforces a durable canary boundary and final target using
`qualifying_success_count + active_reservations`. No eleventh base artist can be claimed before the
ten-success canary is passed, and no 101st base artist can be claimed at a target of 100. Base due
times are persisted and derived from the 24-hour active-mapped population interval, while all HTTP
starts still use the shared ten-second Spotify gate.

Release-detail and release-track scheduler work created by campaign scans carries campaign
attribution. After the base target, only that attributed work may drain; unrelated detail work and
reconciliation remain untouched. Campaign status, member state, attributed work, planning,
pause/resume/cancel, canary advancement, and one-tick execution are exposed through
`pnpm spotify:campaign`. Temporary Windows task scripts run non-overlapping short-lived ticks and
store no credentials. No permanent task is registered by the implementation.

Spotify catalog coverage is separate from canonical music data. `spotify_artist_coverage` stores the current cycle, next offset, status, page counts, and reconciliation timestamps. `spotify_page_scans` retains page-level operational history. `spotify_catalog_releases` retains validated provider summaries so old or unchanged releases do not require full album requests and do not create feed records. The artist becomes fully reconciled only after Spotify omits the next-page cursor.

All scan modes share the global operation lock, the PostgreSQL Spotify request gate, and the configured request budget. A budget stop is paused work, not a provider failure. Completed pages and their next cursor remain committed, and a later process resumes the same artist. A 429 still stops all Spotify activity and persists the provider cooldown.

Spotify artist-catalog pagination and release-track pagination have independent checkpoints. Each selected release persists its expected track total, completed track-page offsets, unique provider track IDs, disc and track positions, next offset, status, discrepancy, and optional reconciliation cycle. The scanner awaits each database checkpoint before requesting another track page. A terminal provider page marks the release complete only when the unique persisted count equals `total_tracks` and no page error remains.

Canonical recording identity does not imply one release. `release_track_appearances` associates one canonical track with every provenance-proven single, EP, album, deluxe, compilation, remix, live, or reissue presentation. `release_track_appearance_sources` retains the candidate and provider IDs that prove each relationship. The feed shows every distinct release appearance and deduplicates repeated observations of the same appearance. Group ordering uses disc number, track number, provider order, title, and stable ID in that order.

Persisted Spotify artist work stores the expected confirmed Spotify artist ID. If that mapping disappears or changes before resume, the artist becomes `blocked_mapping`; other artists can continue, and retry becomes eligible only after the expected mapping is restored. No replacement mapping is selected automatically.

## Feed delivery

The feed API applies status, provider, release type, artist, date, Spotify availability, review, search, and sort predicates in PostgreSQL. Signed query-bound cursors contain only the stable release-date, precision, first-seen, and UUID position. The default page is 100 items with a permitted range of 25 through 200.

A release is the pagination unit. Album and EP groups remain intact even when one group exceeds the nominal page size. Projection queries are bounded to selected release groups and assemble related rows through Maps and Sets with a fixed maximum of 16 SQL statements per page, not one query per item.

`feed_revisions` is a singleton durable counter and item count. Database triggers update it for feed row changes and for tables that alter visible titles, credits, evidence, availability, artwork, appearances, completeness, or export state. Visible tabs poll only this row every 15 seconds and once on focus. A changed revision displays a notice; refreshing from the top is explicit and does not silently discard loaded pages.
