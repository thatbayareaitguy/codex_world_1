# Showcase public application

`apps/showcase` is a deployable Next.js public site backed by a sanitized catalog. In configured
environments it reads the current immutable snapshot from Neon through the read-only website role.
Local development falls back to the generated JSON snapshot when Neon is not configured. It never
opens the scanner database or calls a music provider at runtime.

## Local development

From the repository root:

```powershell
pnpm showcase:dev -- --hostname 127.0.0.1 --port 3200
```

Open `http://127.0.0.1:3200`.

For the persistent local development site used on Windows, register the hidden at-logon supervisor:

```powershell
pnpm showcase:startup:register
```

The supervisor keeps the loopback-only development server running and restarts it if the process
exits or the releases page stops responding. Remove it with `pnpm showcase:startup:remove`.

## Private local genre review

The persistent loopback supervisor enables the private editor at
`http://127.0.0.1:3200/local/genre-review`. The route and its API return not found unless
`SHOWCASE_GENRE_ADMIN_ENABLED=true` and the request host is loopback. It is intentionally absent
from public navigation.

The editor shows unclassified artists first, supports search and multi-genre assignments, and
offers a Save & Next workflow. Confirmed public-safe assignments are stored in
`lib/confirmed-artist-genres.json`. Research suggestions and evidence are stored only under
`%LOCALAPPDATA%\ShowcasePublicSite\editorial` and enter the public catalog only through a manual
save or the strict, independently corroborated HIGH-confidence automation rule.

Run the resumable local evidence pass from the repository root:

```powershell
pnpm showcase:genre-research
```

The command uses only the official Discogs database endpoint, makes no Spotify or Apple request,
checkpoints after every artist, and keeps source evidence in the ignored local editorial directory.
Use `--refresh` to replace cached research. `--apply-high` applies only independently corroborated,
conflict-free HIGH records; manually decided and skipped artists are never overwritten. The editor
can filter HIGH, MEDIUM, and LOW suggestions, show source terms and conflicts, skip an artist, and
bulk-confirm only eligible HIGH records.

## Branding

The active logo is `public/showcase-logo-v1.png`. The header uses the supplied headset mark with a Manrope wordmark, while the homepage hero displays the complete supplied logo. The theme uses its orange, pink, violet, and blue glow palette. Manrope remains the primary font and DM Mono remains the label and metadata font.

The prior acid-lime theme and social preview are preserved in `docs/showcase-theme-archive`.

## Public publishing contract

`lib/generated-public-catalog.json` is produced by the local scanner-to-Showcase publisher. Its
top-level snapshot has a contract version, a public generation timestamp, artists, releases, and a
fixed Showcase-owned genre taxonomy. `lib/public-catalog.ts` applies public-safe manual genre
confirmations and durable public artist exclusions without importing private suggestion evidence.
Public exclusions are stored by Showcase-owned artist ID in `lib/excluded-public-artists.json`, so
they survive future catalog refreshes without deleting private scanner history.

Public artist records contain only Showcase-owned IDs and slugs, display names, Showcase genre
tags, optional label associations, outbound provider links, and a placeholder-art direction.

Public release records contain only Showcase-owned IDs and slugs, display metadata, public artist references, release and discovery dates, genres, an optional label, track titles and positions, outbound provider links, status, a placeholder-art direction, and optional Apple Music artwork with its source URL and original dimensions.

The contract excludes provider payloads, credentials, internal database IDs, identity evidence,
review and suggestion evidence, scheduler and queue state, quota or cooldown state, playlist
operations, and internal failures. The publisher reads persisted scanner data locally, closes the
database connection, and then matches existing numeric Apple release identities against the Apple
Music Feed album export. It reads Feed Parquet files by bounded byte ranges and stores no raw Feed
response. The validated v3 snapshot is sent through Neon's restricted publishing function and is
also written atomically to the generated JSON fallback. The Showcase application makes no provider
API requests at runtime.

## Apple Music Feed artwork publication

Showcase Feed credentials are local-only and loaded from
`%LOCALAPPDATA%\ShowcasePublicSite\apple-music-feed.env`. The referenced `.p8` key also stays outside
the repository. The required variable names are `SHOWCASE_APPLE_FEED_TEAM_ID`,
`SHOWCASE_APPLE_FEED_KEY_ID`, and `SHOWCASE_APPLE_FEED_PRIVATE_KEY_PATH`. Never copy their values into
the repository or scanner `.env`.

To regenerate the catalog from the dedicated Showcase worktree, point only the publication process
at the production scanner environment file:

```powershell
$env:SHOWCASE_SCANNER_ENV_PATH = 'C:\path\to\scanner\.env'
pnpm showcase:publish
```

The publisher authenticates to `api.media.apple.com`, requests the latest album Feed export, accepts
parts only from `media-feed.cdn-apple.com`, and accepts artwork only from Apple's validated
`is1-ssl` through `is5-ssl.mzstatic.com` image hosts. Artwork remains unchanged, is never downloaded,
proxied, cropped, or overlaid, and always links to the corresponding Apple Music album. Releases
without an exact Feed match retain the neutral placeholder.

## Neon database foundation

The owner-only Neon bootstrap and least-privilege design are documented in
`docs/showcase-neon.md`. The local publisher credential can only execute the validated snapshot
publishing function and read the current public view. The website credential can only read that
view and uses Neon's pooled endpoint. Both credentials live under `%LOCALAPPDATA%\Showcase` with
restricted Windows ACLs and never enter the repository.

`pnpm showcase:publish` sends the validated `showcase-public-v3` snapshot to Neon through the local
publisher credential, then refreshes `lib/generated-public-catalog.json` as the development
fallback. The website uses `SHOWCASE_NEON_PUBLIC_DATABASE_URL` from the process environment or the
local website credential file. Set `SHOWCASE_CATALOG_SOURCE=json` to force the fallback in local
tests. A Vercel runtime refuses the fallback and requires the read-only Neon configuration.
