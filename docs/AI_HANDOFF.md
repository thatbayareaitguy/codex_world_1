# AI Handoff

Updated: 2026-08-05 20:34 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Current commit: the documentation checkpoint containing this file. Its parent is `ece61a8`
  (`docs: record Spotify cross-service identity boundary`).
- Current milestone: manual Apple Music artist identity resolution.
- The worktree contains only this handoff update. No application source, playlists, scheduler state,
  provider credentials, or local configuration changed.

## Architecture And Database

- TypeScript pnpm monorepo with Next.js web/API, Node scanner and operational CLIs,
  provider-neutral core, Drizzle/PostgreSQL persistence, Zod validation, Vitest, and Playwright.
- PostgreSQL is authoritative for canonical music data, feed state, provider identity status,
  review decisions, provider gates and cooldowns, encrypted OAuth accounts, and playlist ledgers.
- Twenty forward migrations are applied. No migration is needed for this policy finding.
- Active watchlist: 593 artists. Spotify has 593 confirmed identities. Apple Music has 320
  automatic confirmations, 10 manual confirmations, and 263 artists requiring a manual decision
  across 1,283 pending candidate identities.

## Verified

- Current Apple identity bootstrapping uses a persisted static seed artifact. Runtime Apple
  scanning does not repeat live name-only searches and does not use confirmed Spotify names to
  generate Apple search requests.
- The prior 272-artist policy audit found 141 artists with persisted primary-artist Spotify release
  evidence, 226 Spotify-sourced UPC-bearing releases, and no persisted primary Spotify track with a
  canonical ISRC. Spotify-derived evidence remains excluded from Apple lookup.
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
- Manual Apple identities were durably confirmed for 4B (`1464086544`), A.M.C (`455181031`), A.way
  (`1571027485`), and ARTY (`15956984`). Their pending reviews are closed.
- Amplify remains unresolved. The submitted Amplify URL used ARTY ID `15956984`, which would conflict
  with ARTY. Amplify has six pending candidates, including Apple artist ID `1516199278`.

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

- The 263 unresolved Apple Music artist identities still require user decisions or independently
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
