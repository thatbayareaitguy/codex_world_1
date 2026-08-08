# Architecture

## Dormant MusicBrainz execution boundary

MusicBrainz is preserved for possible advanced use but defaults off with
`MUSICBRAINZ_ENABLED=false`. Normal provider selection excludes it. The GUI omits its source,
status, scan, mapping, and review controls. Its API and CLI entry points reject disabled requests
before acquiring operational work. Existing database records remain available to canonical feed
and evidence queries and are not rewritten or deleted.

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

## Apple Music execution boundary

Apple Music discovery is a read-only public-catalog workflow. The scanner creates a short-lived
ES256 developer token from a server-only Media Services private key and never requests a Music User
Token. It uses only confirmed canonical artist mappings. Ambiguous candidates and candidate-free
artists use the same persistent mapping-review workflow as MusicBrainz, with provider-specific
validation and evidence.

Each normal Apple scan creates or resumes a persisted batch. Per-artist windows begin at the last
successful scan or the 30-day floor. Discovery requests only the first `singles` and `full-albums`
view pages, deduplicates releases, and fetches track details only for eligible releases. One absent
view is an empty optional view. If both are absent, one targeted artist request distinguishes a valid
empty catalog from an invalid mapping. Invalid album-track records are recorded in request telemetry
and skipped without discarding valid releases for the same artist.

`apple_music_provider_state` supplies one global request lease, at least 1100 ms between request
starts, durable cooldown state, and queue metrics. Batches persist each artist outcome immediately.
Interrupted `running` rows become retryable on compatible resume, completed artists are not repeated,
and request or runtime budget stops preserve the batch. Valid Apple candidates enter the existing
canonical matching, appearance, evidence, artwork, and feed pathways, so no Apple-only feed exists.

Apple identity ranking is a separate bounded workflow. It begins with retained numeric Apple
candidate IDs and independently confirmed MusicBrainz IDs, never with Spotify-derived query terms or
metadata. Candidate IDs are looked up directly through an Apple-family API, validated catalogs are
persisted for reuse, and the resolver scores only Apple-side name agreement, catalog activity,
genres, labels, titles, and direct co-credits. Those soft signals rank review cards but cannot cross
the automatic threshold. Only one validated direct MusicBrainz or MusicBrainz-linked Wikidata Apple
artist ID can automatically confirm a mapping. Multiple exact IDs remain a split-profile conflict.
See [Apple Artist Identity Ranking](apple-identity-ranking.md).

## Runtime

- `apps/web`: Next.js UI and server-only OAuth, import, mapping, Reddit source, status, and playlist routes.
- `apps/scanner`: Node.js command for manual, scheduled, filtered, dry-run, backfill, and full scans.
- `packages/core`: provider-neutral types, normalization, matching, logging, and URL safety.
- `packages/db`: Drizzle schema, forward migrations, repositories, OAuth state, token manager, Reddit evidence persistence, scan locks, and operation locks.
- `packages/providers`: runtime-validated Spotify, Apple Music, MusicBrainz, and approval-gated Reddit clients; deterministic Reddit parsing; adapters; import and playlist planners; and MockProvider.
- PostgreSQL: canonical records, provider records, evidence, decisions, cursors, locks, runs, and exports.

Drizzle is used because it keeps the schema and SQL migrations explicit, has a small runtime surface, and permits conflict-safe PostgreSQL writes without generating a separate client.

## Apple-first orchestration

`pnpm sync:apple-first` snapshots the active watchlist's confirmed Apple Music and Spotify artist
IDs in a durable campaign. Apple discovery must finish first. Spotify then processes bounded
cohorts: recent Apple discoveries receive priority, while a rotating allocation covers artists
without a recent Apple result. Spotify calls use only the snapshotted Spotify artist ID and the
bounded Artist Albums catalog path. Spotify Browse New Releases is not used.

Provider ingestion remains independent. Only after both provider records are in PostgreSQL does the
core reconciliation engine compare canonical artist ownership, normalized titles, release types,
dates, track counts, positions, and canonical track or release identities. Material contradictions
and comparable alternatives are persisted as uncertain rather than forced. Campaign tables retain
provider batches, per-artist state, retry eligibility, request and rate-limit telemetry, coverage
counts, and the final read-only playlist preview. Repeated runs resume incomplete work and replace
derived reconciliation rows transactionally.

The preview runtime can read only `SPOTIFY_ALLOWED_PLAYLIST_ID` and constructs a Spotify client with
writes disabled. A live playlist export remains a separate explicit command and approval boundary.
See [Apple-First Discovery And Spotify Reconciliation](apple-first-sync.md).

### First-week bootstrap into the recurring schedule

The first completed Apple-first campaign becomes the initial weekly Apple scan. It is finalized as
`completed_with_spotify_deferred`, so completed Apple discoveries remain authoritative while
unfinished Spotify artist work moves into the rolling scheduler. The transition does not mark any
unscanned Spotify artist complete.

One global discovery schedule records the active campaign and enforces this order: provider
cooldown, campaign playlist inbox, Apple-priority Spotify resolution, broad Spotify reconciliation,
then the next weekly Apple scan. Apple-only, uncertain, and missing-Spotify-track reconciliation
rows create dedicated Apple-priority work. Remaining unfinished campaign artists stay in the broad
rolling backlog. Broad work cannot run while priority work remains.

Recurring operation uses durable local-time jobs. The full Apple watchlist scan is due Thursday at
9:00 PM and the bounded catch-up scan is due Friday at 9:00 AM in
`America/Los_Angeles`. Either job may be recovered for 24 hours after startup; older missed jobs are
expired instead of stacked. Broad Spotify work is blocked on Thursday and Friday and runs only
Saturday through Wednesday. Apple-derived priority work may still use Spotify after provider
readiness checks because it preempts broad rotation. Full-scan priority and Friday catch-up priority
are separate durable phases with an add-only playlist checkpoint between them. When a persisted
Spotify cooldown expires, the scheduler restores the waiting playlist or priority phase instead of
advancing past it.

Broad Spotify claims are limited to 75 distinct artists and 300 request starts per local day. The
rolling 24-hour ceiling retains separate reserves of 200 requests for Apple-priority resolution and
20 for playlist operations. Never-scanned artists precede recurring artists, then recurring artists
are ordered by the oldest successful scan. All work, daily artist claims, Apple jobs, leases,
cooldowns, and next-run timestamps are persisted in PostgreSQL.

The campaign playlist inbox uses only exact Spotify track IDs already proven eligible by the
campaign reconciliation rows. When recurring discovery and playlist writes are both explicitly
enabled, the unified tick automatically runs the existing guarded exporter at each durable playlist
checkpoint. It reads only the configured owned private playlist, plans batched add-only operations,
and inserts discoveries from position zero in newest-first release order while keeping album tracks
contiguous. It never removes, replaces, reorders, renames, or changes the visibility of an existing
playlist item. A Spotify cooldown blocks the checkpoint without discarding its persisted state.

Spotify request telemetry uses durable endpoint buckets: `artist_albums`, `album_detail`,
`album_tracks`, `playlist_read`, `playlist_write`, and `oauth_or_other`. Artist catalog work has a
separate trailing 24-hour allowance of 80 calls, including 20 reserved for Apple-priority work.
Broad work normally receives 60 calls. Unused reserve may be released only late in the window when
no Apple-priority work is queued or leased. Playlist reads and writes use the same PostgreSQL gate
but are not blocked by exhaustion of the Artist Albums bucket.

## Data Flow

1. A user manually creates a canonical artist or explicitly approves a Spotify import preview.
2. Provider IDs are attached to that canonical artist with provenance, confidence, and confirmation state.
3. A provider-specific identity status records whether the mapping was automatic, manually confirmed, confirmed unavailable, split across profiles, intentionally deferred, an alias or duplicate, intentionally excluded, or still requires a manual decision. Review candidates are grouped by canonical artist and provider, and remain evidence rather than mappings until explicitly confirmed.
4. The scanner loads only confirmed mappings and invokes providers independently. Apple Music mapping candidates that are not confirmed remain in review and cannot scan automatically.
5. Typed provider candidates are matched to canonical tracks independently from canonical releases.
6. A transaction preserves provider IDs, source evidence, upcoming history, feed state, availability, match reasons, and the provenance-backed release-to-track appearance.
7. Spotify playlist planning starts from the canonical database-backed feed, keeps followed-artist appearances, selects only exact or manually confirmed Spotify identities, deduplicates repeated recording appearances, and compares the ordered result with current playlist items. Writes default off. When explicitly enabled, route and client guards allow positional additions only to the server-configured owned private playlist.
8. Reddit text is parsed locally, matched only against the canonical watchlist, and enters review unless exact canonical artist and title are corroborated by existing Spotify availability. Reddit content is never sent to AI.

Spotify responses are never submitted to MusicBrainz. MusicBrainz mapping starts from canonical names, user aliases, and confirmed decisions. Canonical display data is provider-neutral; source-specific values remain in external-ID provider fields and evidence records. Apple and Spotify artwork remain separately namespaced and are rendered only when the matching provider supplies evidence for that canonical release appearance.

The browser and CLI cannot supply or select a Spotify write target. `SPOTIFY_ALLOWED_PLAYLIST_ID` is the only target authority. Before every write boundary, the application verifies the returned playlist ID, connected owner, private state, and non-collaborative state. Playlist creation, rename, visibility changes, artwork, follow, unfollow, removal, replacement, and reordering are outside the provider-client surface.

Playlist export uses `spotify_playlist_export_runs` and `spotify_playlist_export_operations` as a durable execution ledger. A run snapshots the exact target and planned counts; each add, already-present item, and skip is persisted separately. Provider readback reconciles writes that succeeded before a local interruption, and the unique export ledger prevents duplicate managed additions. New releases are planned first, album tracks remain contiguous in disc and track order, and user-added tracks keep their relative order. Existing order conflicts and provider-side duplicates are reported but are never repaired automatically because remove and reorder operations are prohibited.

## Resilience

Provider clients have timeouts, bounded retries, structured errors, pagination, and rate-limit
handling. Every Spotify Web API and token request uses one PostgreSQL-backed client-ID queue with a
single lease, a ten-second production minimum start interval, safe request events, and a persistent
global cooldown. A Spotify 429 is not retried. Its body is inspected only through a bounded 4 KB
parser at the documented `error.reason` location. Request telemetry stores the normalized
`quota_exceeded`, `unspecified_429`, or `unknown_reason` classification and an optional safe reason
token; historical events without that evidence aggregate as `legacy_unknown`. Raw response bodies
and arbitrary messages are never retained. Doctor reports the latest safe event and rolling
classification counts. Classification does not alter the request gate, pacing, Retry-After, or
cooldown behavior. Apple Music and MusicBrainz each use independent shared serial request gates.
Apple request events retain only safe endpoint, timing, status, response-size, cooldown, and error
classification fields. Reddit uses its own global request gate and cannot instantiate without
recorded approval. Provider failures are isolated.

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
