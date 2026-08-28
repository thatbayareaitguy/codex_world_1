# Showcase public application

`apps/showcase` is a deployable Next.js public site backed by a generated, sanitized local catalog.
It is intentionally independent from the private scanner runtime and never opens the scanner database
or calls a music provider at runtime.

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
`%LOCALAPPDATA%\ShowcasePublicSite\editorial` and never enter the public catalog unless an editor
chooses genres and saves them.

## Branding

The active logo is `public/showcase-logo-v1.png`. The header uses the supplied headset mark with a Manrope wordmark, while the homepage hero displays the complete supplied logo. The theme uses its orange, pink, violet, and blue glow palette. Manrope remains the primary font and DM Mono remains the label and metadata font.

The prior acid-lime theme and social preview are preserved in `docs/showcase-theme-archive`.

## Public publishing contract

`lib/generated-public-catalog.json` is produced by the local scanner-to-Showcase publisher. Its
top-level snapshot has a contract version, a public generation timestamp, artists, releases, and a
fixed Showcase-owned genre taxonomy. `lib/public-catalog.ts` applies public-safe manual genre
confirmations without importing private suggestion evidence.

Public artist records contain only Showcase-owned IDs and slugs, display names, Showcase genre
tags, optional label associations, outbound provider links, and a placeholder-art direction.

Public release records contain only Showcase-owned IDs and slugs, display metadata, public artist references, release and discovery dates, genres, an optional label, track titles and positions, outbound provider links, status, and a placeholder-art direction.

The contract excludes provider payloads, credentials, internal database IDs, identity evidence,
review and suggestion evidence, scheduler and queue state, quota or cooldown state, playlist
operations, and internal failures. The publisher reads persisted scanner data locally and makes no
provider requests. The Showcase application makes no database or provider requests.
