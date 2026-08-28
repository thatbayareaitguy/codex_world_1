# Showcase local publication bridge

Updated: 2026-08-27

## Boundary

Showcase consumes a generated JSON snapshot. It never connects to the scanner PostgreSQL database
and never calls Spotify or Apple Music APIs. The explicit publisher is the only database reader:

```text
persisted scanner tables
  -> Apple-origin eligibility and strict Spotify reconciliation
  -> allowlist-only public projection
  -> strict Zod validation
  -> atomic local JSON write
  -> Showcase static import and build
```

Run `pnpm showcase:publish` from a private scanner checkout where `DATABASE_URL` is already
configured. The command writes `apps/showcase/lib/generated-public-catalog.json`. It does not make
provider requests and does not modify `.env`.

## Eligibility

- A release must have both an `apple_music` release external record and at least one persisted Apple
  Music release candidate with the same provider release ID.
- The artist name comes from the candidate's confirmed Apple artist mapping.
- Release title, date, and type come from the persisted normalized Apple candidate snapshot, not
  from a shared canonical release that Spotify may also reference.
- A Spotify URL is included only when the latest persisted provider reconciliation for that Apple
  release is `matched` or `missing_spotify_track`, names a Spotify release ID, and that ID has a
  validated `https://open.spotify.com/album/` URL.
- `apple_only` and unresolved Apple releases remain publishable with Apple Music only.
- `spotify_only` records cannot enter the source query.
- Apple Music URLs must use HTTPS on `music.apple.com`. Invalid Apple URLs exclude the record.
- No persisted artwork URL is published. Showcase keeps its neutral generated placeholders.

## Public contract v1

The top-level object contains only:

- `contractVersion`: `showcase-public-v1`
- `generatedAt`: ISO timestamp for the export
- `releases`: public release array

Each public release contains only:

- `publicId`: deterministic Showcase-owned ID derived from a one-way hash of the Apple release ID
- `slug`: public artist and title slug with a deterministic hash suffix
- `artistName`
- `title`
- `type`
- `status`: `upcoming` or `released`
- `releaseDate`
- `firstDiscoveredDate`
- `genres`: currently empty until normalized public taxonomy is available
- optional `label`: not currently emitted
- `tracks`: public disc number, position, and title only
- `links.appleMusic`
- optional `links.spotify`
- `artworkTone`: Showcase-owned neutral placeholder presentation value

The publisher constructs every object field by field and validates strict objects before writing.
Database UUIDs, provider IDs, scheduler state, provider errors, quota or cooldown data, playlist
state, evidence, matching reasons, review state, raw payloads, and credentials are not part of the
schema and cannot pass strict validation.

## Current local snapshot

The 2026-08-27 export contains:

- 371 Apple-origin releases
- 217 releases with an already-reconciled Spotify album URL
- 154 releases with Apple Music only
- 368 released and 3 upcoming releases
- 367 releases with a persisted Apple track listing and 4 without one

The six original artist fixtures and their editorial genre taxonomy remain available on Showcase's
artist pages. Fictional release fixtures were removed.

## Product decisions still needed

- Decide whether the scanner should persist Apple genres and labels into dedicated normalized,
  public-safe fields. The publisher intentionally does not inspect private raw provider payloads.
- Decide whether the four releases without persisted tracks should remain visible, be labeled as
  incomplete, or wait for a track listing.
- Decide how full collaboration and featured-artist credits should be represented. Version 1 uses
  the canonical artist attached to the confirmed Apple mapping.
- Decide whether Showcase should add editorial overrides for genre, label, and atypical release-type
  display without changing scanner evidence.

## Verification

- Unit tests cover strict allowlisted output, deterministic public identifiers, status calculation,
  provider URL validation, Apple-only behavior, and private-field non-copying.
- The isolated PostgreSQL integration test creates Apple-plus-Spotify, Apple-only, and Spotify-only
  fixtures and verifies the exported result is exactly two Apple-origin records with the correct
  link split.
- Showcase tests inspect its source tree for scanner database and provider runtime dependencies and
  validate every generated URL host and public field shape.
