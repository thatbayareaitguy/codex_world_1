# Isolated iTunes Search API Pilot Design

Verified: 2026-07-28

## Purpose and boundary

This branch evaluates the archived, free iTunes Search API as a release-discovery source for one
frozen 50-artist cohort. It does not enable Apple Music API access, Spotify confirmation, feed
ingestion, playlist activity, artwork, previews, authentication, or scheduled execution.

The provider family is the existing `apple_music` canonical identifier. The source API is
`itunes_search`. This preserves a future path for compatible Apple identifiers without creating
conflicting `itunes` and `apple_music` providers.

## Environment isolation

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_itunes`
- Branch: `codex/itunes-discovery`
- Compose file: `docker-compose.itunes.yml`
- Compose project: `codex_world_1_itunes`
- Application: `http://127.0.0.1:3001`
- Database: `radar_itunes` on `127.0.0.1:55433`
- Test database: `radar_itunes_test` on `127.0.0.1:55434`
- Volume: `codex_world_1_itunes_radar-itunes-postgres`
- Ignored runtime configuration: `.app-runtime/itunes.env`

`RADAR_ENV_FILE` is the only supported way to select the pilot runtime file. It contains no
Spotify, Reddit, SoundCloud, Apple, or MusicBrainz credential. All non-iTunes providers and
playlist writes are disabled. The CLI rejects any database other than
`postgres://...@127.0.0.1:55433/radar_itunes`.

## Frozen snapshot

The exporter opens one PostgreSQL transaction with repeatable-read and read-only characteristics.
It selects exactly 50 unique successfully covered Spotify artists:

- 30 positive artists with a canonical Spotify release in the 60-day window
- 10 negative artists without a canonical Spotify release in the window
- 10 identity-stress artists selected deterministically from short, numeric, punctuated,
  initial-like, alias-bearing, or collaborative names

The snapshot contains only approved artist identity, inclusion, coverage, release, credit, track,
position, completeness, and feed-eligibility fields. It recursively rejects credential, token,
authorization, request-header, cooldown, campaign, lease, playlist, and personal-account keys. A
SHA-256 digest covers the sanitized contents. The JSON remains outside both repositories.

The source schema has no stored genre field suitable for this export. The pilot records an empty
genre list and does not infer labels.

## Persistence

Migration `0017_redundant_living_mummy.sql` adds pilot-only tables for:

- frozen snapshots, artists, and Spotify ground-truth releases
- bounded pilot runs
- artist mapping candidates and decisions
- normalized collections and tracks
- cross-provider comparisons
- durable request state, telemetry, and normalized response cache
- bounded batch experiments

No pilot table writes to production feed items, canonical candidates, review queues, Spotify
coverage, Spotify scheduler data, Spotify campaign data, or playlist tables.

## HTTP client and request gate

The client permits only:

- `https://itunes.apple.com/search`
- `https://itunes.apple.com/lookup`

It rejects other schemes, hosts, credentials, and paths. Search uses `musicArtist`, US storefront,
English response language, explicit results, and a limit of 10. Individual artist lookup uses
album and recent-song entities with a limit of 200.

The database-backed global gate provides:

- concurrency one
- at least 3.2 seconds between request starts
- one 200-request ceiling per run
- one 30-minute run deadline
- a recoverable 30-second lease
- durable request start, completion, status, byte count, Retry-After, error classification, and
  cache-hit evidence
- normalized request-identity caching and idempotent reruns

Responses are read through a 5 MiB bound, parsed defensively, and reduced to approved metadata.
Transient server failures have at most three attempts. HTTP 429 is not probed or bypassed.

Unknown response fields, raw bodies, arbitrary headers, artwork URLs, preview URLs, cookies,
prices, and personal account data are not persisted or logged.

## Artist mapping

Mapping is deterministic:

1. Normalize Unicode, case, whitespace, punctuation, ampersands, and common collaboration words.
2. Confirm one unique exact normalized canonical-name result.
3. Evidence-confirm one unique exact stored-alias result.
4. Mark multiple exact or alias candidates ambiguous.
5. Mark an empty search no-match.
6. Never confirm from rank, popularity, genre, spelling similarity, or a partial word.

Only `exact_confirmed` and `evidence_confirmed` mappings proceed. Every returned candidate, decision
reason, ambiguity reason, confidence, and evidence item is retained in the pilot database.

## Discovery and comparison

Individual album and song lookup establish the baseline. Collections deduplicate by `collectionId`;
tracks deduplicate by `trackId`. Original names, normalized titles, version markers, credits,
dates, positions, duration, explicitness, source path, and validated Apple store links remain
separate.

Comparison requires confirmed canonical artist identity and scores:

- normalized title and base-title compatibility
- explicit version-marker agreement or conflict
- release-date distance
- track-count agreement

Results are `exact_match`, `strong_probable_match`, `ambiguous_match`,
`apple_only_or_spotify_missing`, `spotify_ground_truth_missed_by_itunes`, or
`identity_mapping_failure`. Unmatched Apple candidates are not labeled false positives.

Album and song batches of 5 and 10 ordinary iTunes artist IDs are compared with the union of
individual results. Batching is safe only if every artist and individual result is represented and
attribution is deterministic. Individual evidence remains authoritative otherwise.

## Apple policy and API limitations

Apple's documentation is archived. It describes approximately 20 calls per minute, subject to
change, result limits from 1 to 200, and caching. It does not prove paging, continued availability,
ordinary-iTunes-ID batch completeness, release ordering, historical completeness, or a production
service commitment.

Apple's promotional-content terms restrict artwork and previews. This pilot never downloads,
caches, renders, proxies, transforms, or plays those assets. It stores only normalized metadata and
validated store links. This design does not claim Apple approval.

## Live gate

Live execution is allowed only after format, lint, strict TypeScript, unit tests, integration tests,
clean and upgrade migrations, build, Playwright, doctor, and `git diff --check` pass, followed by a
committed and pushed implementation checkpoint. Plan mode requires the committed worktree to be
clean, exactly 50 imported artists, the frozen snapshot, and zero iTunes request events.
