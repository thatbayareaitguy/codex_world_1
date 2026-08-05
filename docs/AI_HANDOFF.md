# AI Handoff

Updated: 2026-08-04 22:35 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Current checkpoint: `fix: require complete Spotify playlist write scopes`, the commit containing
  this handoff. Its parent is `c8a961ce8fe8141916a6b7a5306741ce21b68010`.
- Worktree and upstream: clean and synchronized after the normal push of this checkpoint. Local
  configuration and secrets remain ignored.
- Current milestone: Spotify add-only export to one configured owned private playlist. Live export,
  idempotency, complete credential-free verification, and checkpointing are complete.

## Architecture And Database

- TypeScript pnpm monorepo with Next.js web/API, a Node scanner and operational CLIs,
  provider-neutral core, Drizzle/PostgreSQL persistence, Zod provider validation, Vitest, and
  Playwright.
- PostgreSQL is authoritative for canonical music data, feed state, matching and review decisions,
  provider gates and cooldowns, OAuth accounts, and durable playlist-export runs and operations.
- Nineteen forward migrations are applied. No migration was required for the dual-scope correction.
- Spotify writes default off. When enabled, browser input cannot override the single configured
  playlist ID. Ownership, private visibility, non-collaborative status, exact or manually confirmed
  matching, and add-only behavior remain enforced at route, service, and provider-client layers.

## Verified

- A clean Authorization Code flow retired the prior tokens, used `show_dialog=true`, and persisted
  a newly issued encrypted refresh token. The granted scopes are `user-follow-read`,
  `playlist-read-private`, `playlist-modify-private`, and `playlist-modify-public`.
- One in-memory token was used for `GET /me`, target-playlist verification, and a direct one-item
  append to the configured playlist. The current user matched the playlist owner, the playlist was
  private and non-collaborative, the write returned HTTP 201 with a `snapshot_id`, and readback
  found the canary while privacy remained unchanged.
- The normal exporter reconciled the direct canary, added three canary items, then resumed the same
  durable run and added the remaining 804 items in nine groups of at most 100. The completed ledger
  records 808 exported, 0 pending, and 0 failed operations.
- Final readback and dry run report 808 eligible and present tracks, 0 proposed additions, 0
  duplicate playlist tracks, 0 ordering conflicts, and 115 skips: 65 duplicate recording
  appearances and 50 missing Spotify matches. No remove, replace, reorder, rename, visibility,
  artwork, follow, unfollow, creation, selection, or other-playlist request occurred.
- Export eligibility is limited to active followed-artist feed records with exact or manually
  confirmed Spotify identities. The exported set contains 800 exact and 8 manually confirmed
  matches, 806 `new` and 2 `upcoming` feed items, no dismissed or unresolved-review items, and
  release dates from 2026-05-21 through 2026-09-25. It is the bounded discovery-campaign backlog,
  not unrestricted catalog history.
- Complete verification passes: formatting, lint, strict type checking, production build, 370 unit
  tests in 46 files, 96 PostgreSQL integration tests in 17 files, and 26 Playwright tests. One
  existing parallel Playwright timing test passed immediately in isolation and the complete suite
  passed on rerun.
- `pnpm doctor` reports READY with 19 migrations, both playlist modification scopes, no Spotify
  cooldown, no stale lock, and the application responding on `127.0.0.1:3000`.

## Implemented But Not Yet Fully Verified

- No current-milestone capability remains unverified. Future automatic exports and behavior after
  additional feed discoveries remain outside this one-time live validation.

## Provider And Policy State

- Spotify is connected with both playlist modification scopes. No cooldown or stale request lock
  was observed during the successful export. All token and Web API requests used the shared
  PostgreSQL-backed gate with concurrency one and at least ten seconds between starts.
- Requesting `playlist-modify-public` grants account-level OAuth permission only. The application
  still cannot select another playlist or change playlist visibility.
- Apple Music public-catalog discovery and MusicBrainz remain separate. Reddit is approval-gated.
  SoundCloud automation, YouTube, and TIDAL remain excluded or deferred.

## Known Risks

- Spotify documents `playlist-modify-private` for private-playlist writes, but this Development Mode
  app returned HTTP 403 until the token also contained `playlist-modify-public`. This behavior is
  now directly verified but remains a provider-documentation discrepancy.
- Existing playlist order conflicts can only be reported, not repaired, because automatic reorder
  is intentionally unavailable.
- Feed records without a confirmed Spotify track remain skipped until later matching or manual
  review resolves them.

## Immediate Next Step

Keep playlist export idle until new eligible discoveries exist. Before a future live export, review
the dry-run plan and explicitly confirm that the configured single-playlist write gate should remain
enabled.

## Deferred

- Any second playlist target or playlist picker.
- Playlist creation, deletion, rename, visibility changes, artwork, follow/unfollow, removal,
  replacement, reordering, or automatic cleanup of user-added items.
- Combined playback, mixed-provider queues, SoundCloud automation, Reddit live access, YouTube,
  TIDAL, multi-user deployment, and commercial operation.
