# Architecture

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
6. Spotify playlist planning selects only exact or manually confirmed Spotify tracks and compares them with current playlist items before batching additions.
7. Reddit text is parsed locally, matched only against the canonical watchlist, and enters review unless exact canonical artist and title are corroborated by existing Spotify availability. Reddit content is never sent to AI.

Spotify responses are never submitted to MusicBrainz. MusicBrainz mapping starts from canonical names, user aliases, and confirmed decisions. Canonical display data is provider-neutral; source-specific values remain in external-ID provider fields and evidence records.

## Resilience

Provider clients have timeouts, bounded retries, structured errors, pagination, and rate-limit handling. Spotify handles 401 refresh and exact `Retry-After`. MusicBrainz uses one shared serial request gate. Reddit uses its own global request gate and cannot instantiate without recorded approval. Provider failures are isolated.

One global operation lock serializes normal and provider-specific scans. Provider locks still guard persistence. Expired locks are visible through `scan:status` and only stale locks can be cleared. Detailed scan errors and metrics expire while aggregate history remains.

The local application lifecycle is intentionally simple: Docker Compose runs PostgreSQL, `app:up` migrates before binding Next.js to loopback, and external Task Scheduler or cron runs scans. PostgreSQL custom-format backups are stored outside the repository and restore requires explicit replacement confirmation.

The scheduled strategy uses a 60-day default backfill for initial runs, daily recent reconciliation, and a separate less frequent explicit `--full` scan. Provider ordering is not treated as an updated-since guarantee.
