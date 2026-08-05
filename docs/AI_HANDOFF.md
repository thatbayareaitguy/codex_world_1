# AI Handoff

Updated: 2026-08-05 13:15 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Current commit: the documentation checkpoint containing this file. Its implementation parent is
  `45f5643` (`feat: harden artist identities and playlist auditing`).
- Current milestone: policy review for exact-evidence Apple Music identity resolution.
- No application source, provider data, mapping decisions, playlists, scheduler state, or local
  configuration changed during this review.

## Architecture And Database

- TypeScript pnpm monorepo with Next.js web/API, Node scanner and operational CLIs,
  provider-neutral core, Drizzle/PostgreSQL persistence, Zod validation, Vitest, and Playwright.
- PostgreSQL is authoritative for canonical music data, feed state, provider identity status,
  review decisions, provider gates and cooldowns, encrypted OAuth accounts, and playlist ledgers.
- Twenty forward migrations are applied. No migration is needed for this policy finding.
- Active watchlist: 593 artists. Spotify has 593 confirmed identities. Apple Music has 320
  automatic confirmations, 1 manual confirmation, and 272 artists requiring a manual decision
  across 1,335 candidate identities.

## Verified

- Current Apple identity bootstrapping uses a persisted static seed artifact. Runtime Apple
  scanning does not repeat live name-only searches and does not use confirmed Spotify names to
  generate Apple search requests.
- Of the 272 unresolved Apple artists, 141 have persisted primary-artist Spotify release evidence.
  Those artists have 226 Spotify-sourced UPC-bearing releases. The other 131 do not have persisted
  primary Spotify release evidence.
- Zero unresolved artists currently have a persisted primary Spotify track with a canonical ISRC.
  Spotify track IDs exist, but retrieving their ISRCs and submitting them to Apple would be a new
  cross-service data transfer.
- Apple officially supports catalog song lookup by ISRC and album lookup by UPC. These endpoints may
  be used only with evidence that is user-provided or independently sourced under a compliant
  provider-neutral workflow.
- Spotify's current Developer Policy prohibits products integrated with content from another
  service and prohibits transferring Spotify data to another service outside narrow transfer
  exceptions. Spotify-derived ISRC/UPC Apple matching was therefore not implemented or live-run.
- The worktree was clean at the start of this review. No provider request, Spotify playlist read or
  write, scheduler execution, or database mutation occurred.
- Verification passes: formatting, lint, strict type checking, production build, 371 unit tests in
  46 files, 96 PostgreSQL integration tests in 17 files, and 28 Playwright tests.
- `pnpm doctor` reports READY with 20 migrations, no provider cooldown, no stale lock, the Spotify
  scheduler disabled, Apple Music disabled, and the application responding on `127.0.0.1:3000`.

## Implemented But Partially Verified

- The grouped Apple identity review and durable identity statuses are implemented and verified.
- The Spotify rolling scheduler and campaign persistence remain implemented and test-covered, but
  automatic execution is disabled.
- Apple Music public-catalog discovery is implemented and previously live-tested, but is disabled
  in the current local configuration.

## Provider And Policy State

- Spotify is connected. The shared PostgreSQL request gate and stored cooldown remain authoritative.
- Playlist writes remain restricted to the single configured playlist and add-only behavior.
- Spotify metadata must remain Spotify-namespaced and must not be sent to Apple Music to resolve an
  Apple identity.
- MusicBrainz is configured. Apple Music is disabled with no active cooldown or request lease.
  Reddit remains approval-gated. SoundCloud automation remains excluded.

## Known Defects And Risks

- The 272 unresolved Apple Music artist identities still require user decisions or independently
  sourced exact evidence. They remain excluded from automatic Apple scanning and cross-provider
  matching until resolved.
- Using Spotify-derived identifiers for Apple lookup would create a policy violation even though the
  identifier-matching algorithm itself could be technically deterministic.
- Three Spotify playlist release groups remain noncontiguous. Reordering remains prohibited.

## Immediate Next Step

Choose one compliant Apple identity workflow:

1. Continue manual Apple URL/ID entry through the existing grouped review UI.
2. Use independently sourced MusicBrainz ISRC/UPC evidence only where a canonical MusicBrainz
   identity is already confirmed, then keep Spotify entirely outside that request and decision path.
3. Obtain written Spotify approval for the proposed cross-service identifier workflow before any
   Spotify-derived Apple lookup is implemented.

## Decisions Needed

- Whether to prioritize manual Apple ID entry or build the narrower MusicBrainz-to-Apple exact
  evidence workflow.
- Whether written Spotify approval will be requested for broader cross-service identity matching.

## Deferred

- Spotify-derived Apple Music identity resolution.
- Automatic resolution of ambiguous name-only artist candidates.
- Playlist reorder, scheduler activation, additional providers, mixed playback, multi-user
  deployment, and broad internal identifier renaming.
