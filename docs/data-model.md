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

- `releases` and `tracks`: canonical titles, date precision, classification, barcodes, ISRC, version, duration, position, and MusicBrainz relationships.
- `release_external_ids` and `track_external_ids`: provider-specific IDs, URLs, and namespaced fields. Multiple provider IDs may point at one canonical entity.
- `track_credits`: ordered credited names and explicit roles without erasing source spelling.
- `track_availabilities`: provider, region, state, URL, and provider track ID.
- `release_candidates`: immutable normalized observations, raw minimized fields, payload hash, match rule, confidence, reasons, algorithm version, and canonical target.
- `source_evidence`: independent provider evidence URLs and payload fingerprints.
- `upcoming_announcements` and `upcoming_date_history`: future date, precision, source confidence, evidence, and every observed date change.
- `feed_items`: canonical user state with stable user dedupe key and release or track relationship.
- `reddit_sources`: local subreddit configuration, lookback, overlap, parser signals, cursor, and last error.
- `reddit_submissions`, `reddit_parse_results`, and `reddit_external_links`: minimized retained source text, versioned deterministic parse output, and unverified outbound evidence. Author, score, comments, votes, media, and HTML are not stored.
- `reddit_candidate_matches` and `reddit_reconciliation_runs`: canonical corroboration or review state plus deletion-purge history.

## Operations and Export

- `scan_runs`: trigger, requested/completed/failed providers, filter, dry-run state, start, finish, aggregate counts, sanitized errors, metrics, and detail expiry.
- `operation_locks`: one global expiring operation lock for scan serialization and interruption recovery.
- `scan_locks`: one expiring lock per provider.
- `provider_cursors` and `provider_cache`: scoped checkpoints and sanitized cached metadata.
- `playlist_targets`: one Spotify target, name, private provider ID, snapshot, auto-add policy, and last sync.
- `playlist_exports`: one app-owned addition per target and Spotify track with status and timestamp.
- `manual_match_decisions`: explicit track match decisions.
- `external_links`: optional manual HTTPS outbound links. SoundCloud records remain off by default and never imply automated availability.

## Constraints

Unique constraints protect provider IDs, user follows, import candidates, candidates by provider release and track, canonical ISRC, provider availability by region, evidence fingerprints, feed items, playlist additions, cursors, mappings, and upcoming source IDs. Forward migrations are the executable source of truth; existing migration history is not rewritten.
