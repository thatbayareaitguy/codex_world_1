# Showcase publication bridge

Updated: 2026-09-02

## Boundary and flow

Showcase never connects to the private scanner database and never calls a music provider at
runtime. Publication is an explicit local operation:

```text
persisted scanner tables
  -> active watched artists with confirmed Apple identities
  -> Apple-origin release eligibility and strict persisted Spotify reconciliation
  -> Showcase editorial genres and public exclusions
  -> Apple Music Feed artwork match by existing Apple release identity
  -> strict showcase-public-v3 Zod validation
  -> restricted Neon publish_catalog function
  -> atomic generated JSON fallback write
  -> Showcase server read through the Neon read-only view
```

Run `pnpm showcase:publish` from the dedicated Showcase worktree. The publication process may be
pointed at the private scanner environment file with `SHOWCASE_SCANNER_ENV_PATH`; it does not copy or
modify that file. Apple Music Feed credentials and the Neon publisher credential are loaded from
ignored local configuration. Scanner discovery, scheduling, providers, and playlists are not
changed or invoked.

## Eligibility

### Artists

- An artist must have an active persisted watch and a confirmed Apple Music artist mapping.
- The Apple Music artist URL must be a validated HTTPS artist URL on `music.apple.com`.
- A Spotify artist URL is optional and is copied only from an already-confirmed persisted mapping.
- Genres come only from the fixed Showcase taxonomy and authoritative Showcase editorial data.
- Label associations are optional and are omitted unless reliable.

### Releases

- A release must have persisted Apple Music release evidence belonging to a publishable artist.
- Spotify-only records cannot enter the source query.
- Spotify is optional outbound-link enrichment from a confidently resolved persisted match only.
- Apple-only releases remain publishable.
- Linked artist credits point to published Showcase artist slugs. Valid name-only credits represent
  collaborators without a publishable artist page.
- Releases inherit linked-artist genres. The contract permits a future release-specific override.
- Labels are optional. Trackless releases remain public without a track list.
- Artwork is included only after an exact Apple Music Feed identity match. It is displayed from the
  validated Apple artwork host unchanged and links to the corresponding Apple Music release.

## Public contract v3

The strict top-level object contains only:

- `contractVersion`: `showcase-public-v3`
- `generatedAt`: ISO timestamp
- `genres`: Showcase-owned `slug` and display `name`
- `artists`: public artist records
- `releases`: public release records

Each public artist contains only:

- `publicId`: deterministic Showcase-owned ID derived from a one-way hash
- `slug`
- `name`
- `genreSlugs`
- optional `labelAssociations`
- `links.appleMusic`
- optional `links.spotify`
- `artworkTone`: Showcase-owned neutral fallback presentation

Each public release contains only:

- `publicId`: deterministic Showcase-owned ID derived from a one-way hash
- `slug`
- `artistCredits`: ordered public names with optional Showcase artist-page slugs
- `title`
- `type`
- `status`: `upcoming` or `released`
- `releaseDate`
- `firstDiscoveredDate`
- `genreSlugs`
- optional `label`
- `tracks`: public disc number, position, and title only
- `links.appleMusic`
- optional `links.spotify`
- optional `artwork`: `source: apple_music`, public Apple image URL, width, and height
- `artworkTone`: neutral fallback presentation

The publisher constructs every object field by field and validates strict objects before either
output. Database IDs, provider IDs, credentials, provider payloads, identity evidence, matching
reasons, review and research evidence, scheduler state, provider errors, quota or cooldown data,
playlist state, and internal failures cannot pass the public schema.

## Showcase genre taxonomy

The fixed 18-tag taxonomy is:

- Bass Music
- Dubstep
- Riddim
- Melodic Dubstep
- Experimental Bass
- Midtempo Bass
- Trap
- Future Bass
- Drum & Bass
- House
- Bass House
- Tech House
- Progressive House
- Electro House
- Trance
- Techno
- Hard Dance
- Other Electronic

The local publisher applies public-safe confirmed editorial assignments and deterministic parent
relationships. Private suggestion evidence and source URLs never enter the public snapshot.

## Current published snapshot

The bounded 2026-09-02 publication created Neon catalog version 5 with:

- 581 artists, including 258 with one or more confirmed Showcase genres
- 18 genre records
- 409 Apple-origin releases: 406 released and 3 upcoming
- 221 releases with a confirmed Spotify outbound link and 188 with Apple Music only
- 406 releases with exact Apple Music Feed artwork and 3 neutral placeholders
- 13 releases with multiple credits
- 865 public track rows
- 1 unresolved collaborator omitted because no safe public identity was available

## Neon behavior

The publisher URL is loaded from `%LOCALAPPDATA%\Showcase\neon-publisher.env`. That role can execute
only the validated publishing function and read the current public view. It cannot mutate the base
table directly.

The website URL is loaded from `%LOCALAPPDATA%\Showcase\neon-public-web.env` or from the same named
server-side deployment environment variable. That role can read only `showcase.current_catalog`.
It cannot read the base table or execute the publisher function.

When Neon configuration is absent in local development, Showcase reads
`apps/showcase/lib/generated-public-catalog.json`. Vercel requires Neon and refuses this fallback.

## Verification

- Unit tests cover strict public schemas, deterministic integrity hashing, URL restrictions, JSON
  fallback rules, runtime import boundaries, eligibility, linked credits, genre inheritance,
  trackless releases, and private-field non-copying.
- The database integration suite uses isolated test PostgreSQL and synthetic provider fixtures.
- `pnpm showcase:neon:verify` validates both least-privilege roles.
- `pnpm showcase:neon:roundtrip` compares normalized local and Neon snapshots, validates the stored
  hash, and tests denied publisher and website operations.
- Showcase Playwright runs in forced JSON mode for stable regression coverage and can also run
  against Neon with `SHOWCASE_E2E_CATALOG_SOURCE=neon`.
