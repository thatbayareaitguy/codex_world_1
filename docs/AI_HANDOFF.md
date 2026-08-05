# AI Handoff

Updated: 2026-08-05 11:06 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Current commit: the checkpoint containing this document. The starting checkpoint was `faad550`.
- Current milestone: durable artist identity decisions, grouped provider review, user-facing rename to
  **TS New Music Scanner**, default `New` feed view, and read-only Spotify playlist-order audit.
- The checkpoint worktree contains only the implementation, migration, documentation, and tests for
  this milestone. Local configuration, credentials, logs, dumps, backups, screenshots, and traces
  remain excluded.

## Architecture And Database

- TypeScript pnpm monorepo with Next.js web/API, Node scanner and operational CLIs,
  provider-neutral core, Drizzle/PostgreSQL persistence, Zod validation, Vitest, and Playwright.
- PostgreSQL is authoritative for canonical music data, feed state, provider identity status,
  review decisions, provider gates and cooldowns, encrypted OAuth accounts, and playlist ledgers.
- Twenty forward migrations are applied. Migration `0019_eminent_landau.sql` adds one durable
  artist/provider identity status without rewriting prior migrations.
- Active watchlist: 593 artists. Identity status rows: 1,186. Spotify has 593 automatic
  confirmations. Apple Music has 320 automatic confirmations, 1 manual confirmation, and 272
  artists requiring a manual decision.

## Verified

- The feed opens on `New`, with `New` first and `All` second. Other feed content and filters are
  unchanged.
- User-facing product text is **TS New Music Scanner** in the web shell, metadata, privacy page,
  README, PRD, doctor output, and scheduled-task display names. Stable package, database, service,
  and filesystem identifiers remain unchanged.
- Provider mapping reviews are grouped by canonical artist and provider. They show candidate count
  and confirmed cross-provider evidence, persist explicit identity outcomes, reload after decisions,
  and page by artist rather than by candidate row.
- Ambiguous provider candidates are not auto-confirmed. All 272 unresolved Apple Music artists have
  multiple exact normalized-name candidates without enough corroborating evidence.
- Identity rows and grouped review state persisted across a full app and database restart. The live
  review page showed 272 unresolved artists and 1,335 candidate identities after restart.
- A read-only audit touched only Spotify playlist `4l6LaMPL6duulmFe3hRR4Y`: 811 items, 810 eligible
  canonical tracks, 810 already present, no proposed additions, no duplicate track IDs, and no
  release-date ordering conflicts. One unrelated user-added item remains preserved.
- The audit found three exact same-release grouping conflicts: `StarDisc`; `Asleep in the Garden of
Infernal Stars & The Dreams Strange and Eternal - Remixes`; and `UNTAMED`. No playlist write,
  removal, replacement, or reorder occurred.
- Verification passes: formatting, lint, strict type checking, production build, 371 unit tests in
  46 files, 96 PostgreSQL integration tests in 17 files, and 28 Playwright tests.
- `pnpm doctor` reports READY with 20 migrations, no cooldown, no stale lock, scheduler disabled,
  and the application responding on `127.0.0.1:3000`.

## Implemented But Partially Verified

- The Spotify rolling scheduler and campaign persistence remain implemented and test-covered, but
  automatic execution is disabled.
- Apple Music public-catalog discovery is implemented and previously live-tested, but is disabled
  in the current local configuration. This milestone verified its identity review with database and
  browser tests, not live Apple requests.

## Provider And Policy State

- Spotify is connected. The shared PostgreSQL request gate and stored cooldown remain authoritative.
- Playlist writes remain restricted to the single configured playlist and add-only behavior.
- MusicBrainz is configured. Apple Music is disabled. Reddit remains approval-gated. SoundCloud
  automation remains excluded.
- The existing Spotify playlist retains its current provider-side name because playlist rename is
  outside the allowed client surface.

## Known Defects And Risks

- The 272 unresolved Apple Music artist identities require user decisions. They are excluded from
  automatic Apple scanning and cross-provider matching until resolved.
- Three playlist release groups are separated by other playlist items. The audit can identify these
  conflicts, but repository policy prohibits automatic or manual reorder operations through the app.
- Stable internal names still contain `radar` for compatibility. This is intentional and is not
  visible product branding.

## Immediate Next Step

Work through the grouped Apple Music identity queue, starting with artists that have useful
cross-provider evidence. Do not auto-confirm equal-name candidates. Separately decide whether the
playlist policy should ever permit a narrowly scoped reorder tool; it is currently prohibited.

## Decisions Needed

- Whether to keep playlist grouping conflicts as report-only findings or approve a future,
  separately reviewed reorder capability.
- When to enable Apple Music discovery after enough identities are confirmed.

## Deferred

- Automatic resolution of ambiguous artist identities.
- Playlist creation, target selection, rename, visibility changes, artwork, removal, replacement,
  reorder, or cleanup of user-added items.
- Scheduler activation, additional providers, mixed playback, multi-user deployment, and broad
  internal identifier renaming.
