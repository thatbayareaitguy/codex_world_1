# Showcase local publication bridge

Updated: 2026-08-27

## Boundary

Showcase consumes a generated JSON snapshot. It never connects to the scanner PostgreSQL database
and never calls Spotify or Apple Music APIs. The explicit publisher is the only database reader:

```text
persisted scanner tables
  -> active watched artists with confirmed Apple identities
  -> Apple-origin release eligibility and strict Spotify reconciliation
  -> Showcase genre mapping and allowlist-only public projection
  -> strict Zod validation
  -> atomic local JSON write
  -> Showcase static import and build
```

Run `pnpm showcase:publish` from a private scanner checkout where `DATABASE_URL` is already
configured. The command writes `apps/showcase/lib/generated-public-catalog.json`. It does not make
provider requests and does not modify `.env`.

## Eligibility

### Artists

- An artist must have an active persisted watch and a confirmed Apple Music artist mapping.
- The Apple Music artist URL must be a persisted, validated HTTPS URL on `music.apple.com` with an
  artist path. Invalid or missing Apple URLs exclude the artist.
- A Spotify artist URL is optional and is copied only from the artist's already-confirmed persisted
  Spotify mapping after strict host and path validation.
- Apple catalog genre names are mapped through the fixed Showcase taxonomy. Provider genre names
  that have no explicit mapping are ignored rather than guessed or copied through.
- Label associations are optional and may come only from the exact persisted valid Apple artist
  catalog. Empty values are omitted.

### Releases

- A release must have both an `apple_music` release external record and at least one persisted Apple
  Music release candidate belonging to a publishable active artist.
- Release title, date, type, first-discovered date, and tracks come from persisted Apple candidate
  and appearance records.
- A Spotify URL is included only when the latest persisted provider reconciliation for that Apple
  release is `matched` or `missing_spotify_track`, names a Spotify release ID, and that ID has a
  validated `https://open.spotify.com/album/` URL.
- `apple_only` and unresolved Apple releases remain publishable with Apple Music only.
- `spotify_only` records cannot enter the source query.
- Release credits begin with the active watched artist. Exact persisted Apple co-credit IDs add
  other published watched artists as linked credits. A collaborator with a valid persisted Apple
  catalog name may appear as an unlinked name-only credit. Unknown identities are omitted and
  counted for the publication report.
- Releases inherit the union of their linked artists' Showcase genre tags. The source contract
  already accepts an explicit genre override array for future editorial use.
- Exact persisted Apple release labels are optional. Unknown labels are omitted.
- Trackless releases remain public and render without a track-list section.
- No persisted artwork URL is published. Showcase keeps its neutral generated placeholders.

## Public contract v2

The top-level object contains only:

- `contractVersion`: `showcase-public-v2`
- `generatedAt`: ISO timestamp for the export
- `genres`: Showcase-owned taxonomy records with `slug` and display `name`
- `artists`: public artist records
- `releases`: public release records

Each public artist contains only:

- `publicId`: deterministic Showcase-owned ID derived from a one-way hash of the Apple artist ID
- `slug`: public artist slug with a deterministic hash suffix
- `name`
- `genreSlugs`: zero or more references to the Showcase taxonomy
- optional `labelAssociations`
- `links.appleMusic`
- optional `links.spotify`
- `artworkTone`: Showcase-owned neutral placeholder presentation value

Each public release contains only:

- `publicId`: deterministic Showcase-owned ID derived from a one-way hash of the Apple release ID
- `slug`: public artist and title slug with a deterministic hash suffix
- `artistCredits`: ordered public names with optional `artistSlug` links
- `title`
- `type`
- `status`: `upcoming` or `released`
- `releaseDate`
- `firstDiscoveredDate`
- `genreSlugs`: inherited Showcase taxonomy references, or future explicit overrides
- optional `label`
- `tracks`: public disc number, position, and title only
- `links.appleMusic`
- optional `links.spotify`
- `artworkTone`: Showcase-owned neutral placeholder presentation value

The publisher constructs every object field by field and validates strict objects before writing.
Database UUIDs, provider IDs, scheduler state, provider errors, quota or cooldown data, playlist
state, evidence, matching reasons, review state, raw payloads, and credentials are not part of the
schema and cannot pass strict validation.

## Showcase genre taxonomy

The first controlled taxonomy contains 17 tags:

- Ambient
- Bass
- Breaks
- Dance
- Downtempo
- Drum & Bass
- Dubstep
- Electronic
- Electronica
- Experimental
- Garage
- Hardcore
- House
- Industrial
- Techno
- Trance
- Trap

This is a Showcase-owned vocabulary. The publisher maps only exact known persisted Apple genre
labels to these slugs. It does not publish Apple's raw genre array.

## Current local snapshot

The 2026-08-27 export contains:

- 583 real active watched artists, all with validated Apple Music and confirmed Spotify artist URLs
- 243 artists with one or more Showcase genre tags and 340 left unclassified rather than guessed
- 371 Apple-origin releases
- 217 releases with an already-reconciled Spotify album URL
- 154 releases with Apple Music only
- 13 releases with multiple linked published artist credits
- 2 trackless releases, both still visible
- 1 unresolved collaborator reference omitted because no valid persisted public name was available
- 0 artist label associations and 0 release labels because the current persisted exact catalogs did
  not supply a reliable value for these published records

## Product decisions still needed

- Decide whether the 340 unclassified artists should receive manual Showcase genre tags or whether
  the controlled mapping policy should expand beyond its current EDM-focused terms.
- Decide whether a small editorial override artifact should supply release-specific genres and
  labels. The contract and inheritance logic already support future genre overrides.
- Decide whether the one unresolved collaborator should be researched and assigned a public
  name-only credit. No provider lookup is performed by this publisher.

## Verification

- Unit tests cover strict allowlisted output, deterministic public identifiers, artist links,
  controlled taxonomy mapping, genre inheritance and overrides, multi-artist credits, trackless
  releases, provider URL validation, Apple-only behavior, and private-field non-copying.
- The isolated PostgreSQL integration test creates an active watched artist, confirmed provider
  mappings, persisted Apple catalog metadata, Apple-plus-Spotify and Apple-only releases, and a
  Spotify-only release. It verifies that only the two Apple-origin releases publish.
- Showcase tests validate every generated artist and release relationship, URL host and path,
  taxonomy reference, public field shape, and absence of scanner database or provider API runtime
  dependencies.
