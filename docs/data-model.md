# Data Model

## Identity and Watchlist

- `users`: the local owner.
- `oauth_accounts`: Spotify account identity, stable account ID, display name, scopes, encrypted access and refresh tokens, expiry, refresh time, disconnect, and reconnect state.
- `oauth_states`: expiring, hashed, single-use OAuth state and encrypted PKCE verifier.
- `artists`, `artist_aliases`, and `artist_follows`: provider-neutral identity, user aliases, inclusion rules, tracking source, and active state.
- `artist_external_ids`: provider mappings with confirmation, score, reasons, source, provider URL, and timestamps.
- `artist_provider_identity_statuses`: one durable status per canonical artist and provider. It distinguishes automatic and manual confirmations from confirmed-unavailable, alias/duplicate, intentional exclusion, and unresolved manual-decision states without treating review candidates as canonical mappings.
- `artist_import_runs` and `artist_import_candidates`: preview, selection, decision, counts, provenance, and import history.
- `artist_mapping_reviews`: ambiguous MusicBrainz and Apple Music mapping proposals and decisions. Apple candidate-free rows permit a manually supplied numeric catalog artist ID.
- `apple_identity_candidate_catalogs`: reusable, validated Apple-family catalog summaries keyed by
  numeric Apple artist ID, including source, resource state, namespaced artist URL and artwork,
  genres, labels, releases, songs, direct credits, payload hash, and observation time.
- `apple_identity_candidate_rankings`: one calibrated result per canonical artist and Apple
  candidate, including rank, score, reasons, contradictions, exact-link provenance, title overlaps,
  elimination safety, and automatic-confirmation eligibility.

## Catalog and Evidence

- `releases` and `tracks`: provider-neutral release and recording identity. `tracks.release_id` is deprecated but retained as a compatibility pointer to the recording's first canonical release; it is no longer authoritative and is scheduled for removal only in a later compatibility-safe migration.
- `release_track_appearances`: canonical many-to-many release/recording membership with disc number, track number, provider order, presentation metadata, and first/last observation times. Its deterministic identity is release, track, disc, and track position.
- `release_track_appearance_sources`: candidate and provider release/track provenance, observed credits, and observation times for each appearance.
- `release_external_ids` and `track_external_ids`: provider-specific IDs, URLs, and namespaced fields. Multiple provider IDs may point at one canonical entity. Spotify and Apple Music release rows may store provider-namespaced album URLs and validated artwork URLs, dimensions, provider IDs, and observation timestamps. The database stores no image bytes.
- `track_credits`: ordered credited names and explicit roles without erasing source spelling.
- `track_availabilities`: provider, region, state, URL, and provider track ID.
- `release_candidates`: immutable normalized observations, raw minimized fields, payload hash, match rule, confidence, reasons, algorithm version, and canonical target.
- `source_evidence`: independent provider evidence URLs and payload fingerprints.
- `upcoming_announcements` and `upcoming_date_history`: future date, precision, source confidence, evidence, and every observed date change.
- `feed_items`: canonical user state associated with a release appearance. Non-review rows are unique per user and appearance; candidate evidence remains separate. Saved, listened, dismissed, upcoming, and review history survive appearance repair.
- `feed_revisions`: singleton durable feed revision and item count. Triggers advance it transactionally for feed rows and related records that change visible feed projection data.
- `reddit_sources`: local subreddit configuration, lookback, overlap, parser signals, cursor, and last error.
- `reddit_submissions`, `reddit_parse_results`, and `reddit_external_links`: minimized retained source text, versioned deterministic parse output, and unverified outbound evidence. Author, score, comments, votes, media, and HTML are not stored.
- `reddit_candidate_matches` and `reddit_reconciliation_runs`: canonical corroboration or review state plus deletion-purge history.

## Operations and Export

- `scan_runs`: trigger, requested/completed/failed providers, filter, dry-run state, start, finish, aggregate counts, sanitized errors, metrics, and detail expiry.
- `apple_music_provider_state` and `apple_music_request_events`: global request lease, minimum start time, queue depth, request count, cooldown, safe endpoint category, status, response size, and redacted failure classification.
- `apple_music_scan_batches`, `apple_music_artist_scans`, and `apple_music_artist_state`: restart-safe mapped-watchlist batches, ordered per-artist work, date windows, request and candidate counts, terminal or retryable outcomes, and last successful scan state.
- `apple_music_response_cache`: bounded validated response reuse scoped by request identity. It contains no credentials or authorization headers.
- `spotify_provider_state`: singleton client-ID request gate, lease, queue depth, request count, next request time, and provider-directed cooldown evidence.
- `spotify_request_events`: safe endpoint-category metrics, request timing, status, queue wait, raw and parsed `Retry-After`, cooldown, and redacted classifications.
- `spotify_scan_batches`: bounded Spotify mode, page limit, confirmation, pause/cancel state, estimates, and aggregate artist outcomes, including blocked mappings.
- `spotify_artist_scans`: persisted per-artist position, expected Spotify artist ID, timing, request/candidate/page counts, result state, retry eligibility, and heartbeat.
- `spotify_artist_coverage`, `spotify_page_scans`, and `spotify_catalog_releases`: resumable catalog cycle, page evidence, next offset, partial or fully reconciled state, and validated provider release summaries that avoid refetching unchanged records.
- `spotify_release_track_retrievals`: one durable retrieval state per Spotify album ID with canonical release, expected and fetched counts, next offset, page count, status, timing, error, retry, discrepancy, and reconciliation-cycle fields.
- `spotify_release_track_pages` and `spotify_release_track_items`: idempotent completed-page checkpoints and deduplicated provider track IDs with disc/track order.
- `musicbrainz_provider_state` and `musicbrainz_request_events`: singleton request lease plus bounded, secret-safe request timing and outcome telemetry.
- `musicbrainz_scan_batches` and `musicbrainz_artist_scans`: artist-level batch position, stage checkpoints, counts, heartbeat, errors, cancellation, and resume eligibility.
- `operation_locks`: one global expiring operation lock for scan serialization and interruption recovery.
- `scan_locks`: one expiring lock per provider.
- `provider_cursors` and `provider_cache`: scoped checkpoints and sanitized cached metadata. Spotify artwork backfill uses a dedicated cursor scope and advances it only after a release is updated or confirmed to have no usable artwork, so `--resume` starts after the last completed release without changing scan history.
- `playlist_targets`: application export ledger target for the single server-configured Spotify playlist, including name, provider ID, last verified snapshot ID, ordered provider item metadata, snapshot verification time, Custom Order canary time, and last sync. Environment configuration remains the write authority.
- `playlist_exports`: one app-owned addition per target and Spotify track with status and timestamp.
- `manual_match_decisions`: explicit track match decisions.
- `external_links`: optional manual HTTPS outbound links. SoundCloud records remain off by default and never imply automated availability.

## Constraints

Unique constraints protect provider IDs, user follows, import candidates, candidates by provider release and track, canonical ISRC, release appearances, appearance provenance, release-track pages and items, provider availability by region, evidence fingerprints, feed appearances, playlist additions, cursors, mappings, and upcoming source IDs. Forward migrations are the executable source of truth; existing migration history is not rewritten.

Candidates are observations, not immutable canonical truth. Their identity fields and source payload fingerprint are stable, while match target, status, rule, confidence, reasons, and algorithm version may be updated by deterministic rematching or a stored manual decision. A manual decision is preserved separately and remains authoritative over later fuzzy matching.

Operational history is bounded at read time, not deleted: scan history and pending MusicBrainz mapping reviews use deterministic cursor pages, while provider request status exposes bounded recent or aggregate telemetry. Older scan and review rows remain in PostgreSQL.

## Feed-scaling indexes

Migration `0012_common_newton_destine.sql` adds only indexes tied to current predicates:

- `artist_mapping_review_pending_idx`: provider plus pending status and deterministic review ordering.
- `feed_user_seen_id_idx`: owner-scoped first-seen cursor traversal.
- `feed_user_release_seen_idx`: owner-scoped release grouping and release-page selection.
- `feed_track_idx` and `feed_appearance_idx`: reverse projection from selected canonical tracks and appearances.
- `playlist_export_track_status_idx`: bounded export-state projection for selected track IDs.
- `release_candidates_matched_track_seen_idx`: canonical track candidate history ordered by first seen.
- `release_external_release_provider_idx` and `track_external_track_provider_idx`: forward projection from canonical entities to provider evidence. Existing unique provider/external-ID indexes remain the reverse-lookup path.
- `source_evidence_candidate_idx`: evidence projection for selected candidates.
- `track_availability_track_provider_idx`: provider availability for selected tracks.
- `scan_runs_started_history_idx` and `scan_runs_status_provider_started_idx`: deterministic history pages and recent provider/status diagnostics.
- `spotify_artist_coverage_reconcile_idx`: partial reconciliation work ordered by status and age.
- `spotify_release_track_retrieval_resume_idx` and `spotify_release_track_retrieval_release_idx`: resumable album work and release completeness projection.

No new `feed_items.updated_at` index is needed because polling reads the primary-keyed `feed_revisions` singleton. No release-date-only index is added because feed ordering is computed across owner-scoped release groups, not by scanning `releases` directly.
