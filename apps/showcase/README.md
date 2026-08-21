# Showcase public application

`apps/showcase` is a deployable Next.js public site with fixture-only catalog data. It is intentionally independent from the private scanner runtime.

## Local development

From the repository root:

```powershell
pnpm showcase:dev -- --hostname 127.0.0.1 --port 3200
```

Open `http://127.0.0.1:3200`.

## Branding

The active logo is `public/showcase-logo-v1.png`. The header uses the supplied headset mark with a Manrope wordmark, while the homepage hero displays the complete supplied logo. The theme uses its orange, pink, violet, and blue glow palette. Manrope remains the primary font and DM Mono remains the label and metadata font.

The prior acid-lime theme and social preview are preserved in `docs/showcase-theme-archive`.

## Public publishing contract draft

The fixture in `lib/public-catalog.ts` is the first draft of a future scanner-to-Showcase publishing contract. Its top-level snapshot has a contract version, a public generation timestamp, artists, and releases.

Public artist records contain only Showcase-owned IDs and slugs, display names, Showcase genre tags, optional label associations, related public artist slugs, outbound provider links, and a placeholder-art direction.

Public release records contain only Showcase-owned IDs and slugs, display metadata, public artist references, release and discovery dates, genres, an optional label, track titles and positions, outbound provider links, status, and a placeholder-art direction.

The contract excludes provider payloads, credentials, internal database IDs, identity evidence, review state, scheduler and queue state, quota or cooldown state, playlist operations, and internal failures. This milestone has no scanner synchronization mechanism and makes no database or provider requests.
