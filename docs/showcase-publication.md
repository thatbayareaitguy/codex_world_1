# Showcase publication bridge

Updated: 2026-10-04

For scheduling, budgets, safe retries, and operational recovery, see
[Showcase budgeted updates](showcase-update-operations.md).

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
  -> one bounded Neon read before Vercel build
  -> deployment JSON snapshot served without runtime Neon reads
```

Run `pnpm showcase:update` for budgeted publication and deployment from the dedicated Showcase
worktree. `pnpm showcase:publish` updates Neon and local JSON only. The publication process may be
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

The bounded 2026-10-04 Pacific publication created Neon catalog version 7 with:

- 581 artists, including 258 with one or more confirmed Showcase genres
- 18 genre records
- 638 Apple-origin releases: 637 released and 1 upcoming at publication
- 229 releases with a confirmed Spotify outbound link and 409 with Apple Music only
- 635 releases with exact Apple Music Feed artwork and 3 neutral placeholders
- 13 releases with multiple credits
- 1,284 public track rows

## Neon behavior

The publisher URL is loaded from `%LOCALAPPDATA%\Showcase\neon-publisher.env`. That role can execute
only the validated publishing function and read the current public view. It cannot mutate the base
table directly.

The build-reader URL is loaded from `%LOCALAPPDATA%\Showcase\neon-public-web.env` or from the same
named server-side deployment environment variable. That role can read only `showcase.current_catalog`.
It cannot read the base table or execute the publisher function.

Both development and deployed runtime read `apps/showcase/lib/generated-public-catalog.json`.
Vercel requires a successful bounded Neon read before building that snapshot, with no silent stale
fallback at build time. Runtime cannot query Neon, even if its read-only credential is configured.

## Verification

- Unit tests cover strict public schemas, deterministic integrity hashing, URL restrictions, JSON
  fallback rules, runtime import boundaries, eligibility, linked credits, genre inheritance,
  trackless releases, and private-field non-copying.
- The database integration suite uses isolated test PostgreSQL and synthetic provider fixtures.
- `pnpm showcase:neon:verify` validates both least-privilege roles.
- `pnpm showcase:neon:roundtrip` compares normalized local and Neon snapshots, validates the stored
  hash, and tests denied publisher and website operations.
- Showcase Playwright runs against a local build of the generated snapshot, without a live database
  or provider dependency. Production status hashes verify the deployed snapshot matches publication.
