# Data Model

## Identity and Watchlist

- `users`: the local owner.
- `oauth_accounts`: Spotify account identity, stable account ID, display name, scopes, encrypted access and refresh tokens, expiry, refresh time, disconnect, and reconnect state.
- `oauth_states`: expiring, hashed, single-use OAuth state and encrypted PKCE verifier.
- `artists`, `artist_aliases`, and `artist_follows`: provider-neutral identity, user aliases, inclusion rules, tracking source, and active state.
- `artist_external_ids`: provider mappings with confirmation, score, reasons, source, provider URL, and timestamps.
- `artist_import_runs` and `artist_import_candidates`: preview, selection, decision, counts, provenance, and import history.
- `artist_mapping_reviews`: ambiguous MusicBrainz mapping proposals and decisions.

## Catalog and Evidence

- `releases` and `tracks`: provider-neutral release and recording identity. `tracks.release_id` is deprecated but retained as a compatibility pointer to the recording's first canonical release; it is no longer authoritative and is scheduled for removal only in a later compatibility-safe migration.
- `release_track_appearances`: canonical many-to-many release/recording membership with disc number, track number, provider order, presentation metadata, and first/last observation times. Its deterministic identity is release, track, disc, and track position.
- `release_track_appearance_sources`: candidate and provider release/track provenance, observed credits, and observation times for each appearance.
- `release_external_ids` and `track_external_ids`: provider-specific IDs, URLs, and namespaced fields. Multiple provider IDs may point at one canonical entity. Spotify release rows may store `provider_fields.spotify` with the album ID, canonical album URL, selected artwork URL, width, height, source provider, and last-observed timestamp. The database stores no image bytes.
- `track_credits`: ordered credited names and explicit roles without erasing source spelling.
- `track_availabilities`: provider, region, state, URL, and provider track ID.
- `release_candidates`: immutable normalized observations, raw minimized fields, payload hash, match rule, confidence, reasons, algorithm version, and canonical target.
- `source_evidence`: independent provider evidence URLs and payload fingerprints.
- `upcoming_announcements` and `upcoming_date_history`: future date, precision, source confidence, evidence, and every observed date change.
- `feed_items`: canonical user state associated with a release appearance. Non-review rows are unique per user and appearance; candidate evidence remains separate. Saved, listened, dismissed, upcoming, and review history survive appearance repair.
- `reddit_sources`: local subreddit configuration, lookback, overlap, parser signals, cursor, and last error.
- `reddit_submissions`, `reddit_parse_results`, and `reddit_external_links`: minimized retained source text, versioned deterministic parse output, and unverified outbound evidence. Author, score, comments, votes, media, and HTML are not stored.
- `reddit_candidate_matches` and `reddit_reconciliation_runs`: canonical corroboration or review state plus deletion-purge history.

## Operations and Export

- `scan_runs`: trigger, requested/completed/failed providers, filter, dry-run state, start, finish, aggregate counts, sanitized errors, metrics, and detail expiry.
- `spotify_provider_state`: singleton client-ID request gate, lease, queue depth, request count, next request time, and provider-directed cooldown evidence.
- `spotify_request_events`: safe endpoint-category metrics, request timing, status, queue wait, raw and parsed `Retry-After`, cooldown, and redacted classifications.
- `spotify_scan_batches`: bounded Spotify mode, page limit, confirmation, pause/cancel state, estimates, and aggregate artist outcomes, including blocked mappings.
- `spotify_artist_scans`: persisted per-artist position, expected Spotify artist ID, timing, request/candidate/page counts, result state, retry eligibility, and heartbeat.
- `spotify_release_track_retrievals`: one durable retrieval state per Spotify album ID with canonical release, expected and fetched counts, next offset, page count, status, timing, error, retry, discrepancy, and reconciliation-cycle fields.
- `spotify_release_track_pages` and `spotify_release_track_items`: idempotent completed-page checkpoints and deduplicated provider track IDs with disc/track order.
- `operation_locks`: one global expiring operation lock for scan serialization and interruption recovery.
- `scan_locks`: one expiring lock per provider.
- `provider_cursors` and `provider_cache`: scoped checkpoints and sanitized cached metadata. Spotify artwork backfill uses a dedicated cursor scope and advances it only after a release is updated or confirmed to have no usable artwork, so `--resume` starts after the last completed release without changing scan history.
- `playlist_targets`: application export ledger target for the single server-configured Spotify playlist, including name, provider ID, snapshot, and last sync. Environment configuration remains the write authority.
- `playlist_exports`: one app-owned addition per target and Spotify track with status and timestamp.
- `manual_match_decisions`: explicit track match decisions.
- `external_links`: optional manual HTTPS outbound links. SoundCloud records remain off by default and never imply automated availability.

## Constraints

Unique constraints protect provider IDs, user follows, import candidates, candidates by provider release and track, canonical ISRC, release appearances, appearance provenance, release-track pages and items, provider availability by region, evidence fingerprints, feed appearances, playlist additions, cursors, mappings, and upcoming source IDs. Forward migrations are the executable source of truth; existing migration history is not rewritten.
