# AI Handoff

Updated: 2026-08-05 00:23 PDT (UTC-07:00)

Canonical implementation and operational snapshot. Credentials, tokens, private keys, personal
provider data, authorization headers, and raw provider payloads are excluded.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Current milestone commit: the Apple bulk identity workflow commit containing this file; its parent
  is `8534f73`, and requested base `ece61a8` is the preceding implementation checkpoint.
- Worktree and upstream are expected to be clean and synchronized after the milestone push.
- Milestone: compliant bulk Apple Music artist identity resolution.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, Node scanner CLIs, provider-neutral core,
  Drizzle/PostgreSQL, Zod, Vitest, and Playwright.
- PostgreSQL remains authoritative for canonical records, provider identities, review decisions,
  request gates, cooldowns, OAuth data, and export ledgers.
- Twenty-one forward migrations are applied. Migration 0020 adds split-profile and intentionally
  deferred Apple states, multiple Apple IDs, and user notes while backfilling existing IDs.
- Active watchlist: 593. Apple identity state: 320 automatic, 26 manual, and 247 unresolved artists
  across 1,228 pending candidates.

## Verified

- The CSV export prioritizes confirmed MusicBrainz identities and low candidate counts, exports at
  most 100 rows, and contains no Spotify-derived columns or values.
- The generated batch contains 100 rows at
  `C:\Users\taysh\AppData\Local\TSNewMusicRadar\exports\apple-music-identities-priority-2026-08-05.csv`.
- Safe parser accepts only numeric Apple artist IDs or HTTPS `music.apple.com` artist URLs.
- Preview detects missing IDs, duplicate cross-artist assignments, existing mapping conflicts, name
  disagreements, unchanged decisions, and non-mapping outcomes.
- Apply re-verifies exact user IDs and commits the complete batch transactionally. Resolved reviews
  close and confirmed IDs feed existing Apple scans. Split profiles remain excluded from scanning.
- Verification passes: formatting, lint, strict TypeScript, production build, 377 unit tests in 48
  files, 101 PostgreSQL integration tests in 19 files, and 28 Playwright tests.
- Bounded live MusicBrainz pass: two independently confirmed MBIDs evaluated in two requests; 17
  and 4 primary release groups inventoried; zero automatic mappings because Apple verification was
  unavailable. No Spotify request occurred.
- Doctor reports READY, 21 migrations, no stale lock, and no provider cooldown.

## Implemented But Not Fully Verified

- Direct Apple ID preview and transactional apply are unit/integration tested but not live-tested in
  this environment because Apple developer-token variables are absent.
- Exact MusicBrainz-to-Apple catalog confirmation is implemented conservatively: exact MB artist
  name, primary attribution, at least two consistent release-title matches, and one unique winner.
  It has not been live-tested against Apple in the current environment.
- The CLI and database paths are complete; only direct Apple live verification remains blocked by
  local configuration.

## Provider And Policy State

- Spotify remains connected; scheduler execution was not enabled and no playlist was accessed.
- Spotify data is excluded from Apple exports, requests, and identity decisions.
- MusicBrainz is configured. Apple catalog credentials and `APPLE_MUSIC_ENABLED` are absent from the
  current `.env`; no active Apple cooldown or request lease exists.
- Reddit remains approval-gated. SoundCloud automation remains excluded.

## Known Risks

- 247 Apple identities remain unresolved. Weak or absent evidence stays in manual review.
- Split-profile decisions are stored durably but are not scanned until multi-profile scan semantics
  are explicitly implemented.
- A manually entered Apple ID can still be wrong despite an exact resource lookup. Name disagreement
  remains visible in preview and requires the user to review the exact supplied resource.

## Immediate Next Step

Complete the CSV with exact user-selected Apple URLs or IDs. Restore Apple developer-token settings,
then run preview, review all warnings, apply, and verify using the documented commands.

## Deferred

- Spotify-derived Apple identity lookup, name-only automatic confirmation, split-profile scanning,
  scheduler activation, additional providers, mixed playback, and playlist reordering.
