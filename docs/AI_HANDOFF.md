# AI Handoff

Updated: 2026-08-04 23:48 PDT (UTC-07:00)

This is the canonical implementation and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Current acceptance checkpoint: the commit containing this document. Its implementation parent is
  `857b8a6` (`fix: require complete Spotify playlist write scopes`).
- Worktree and upstream were clean and synchronized at the start of acceptance. Only this handoff
  update is intended for the acceptance commit; local configuration and secrets remain ignored.
- Current milestone: final end-to-end MVP acceptance after Spotify dual-scope authorization and
  initial playlist export.

## Architecture And Database

- TypeScript pnpm monorepo with Next.js web/API, Node scanner and operational CLIs,
  provider-neutral core, Drizzle/PostgreSQL persistence, Zod provider validation, Vitest, and
  Playwright.
- PostgreSQL is authoritative for canonical music data, feed state, review decisions, provider
  gates and cooldowns, encrypted OAuth accounts, and durable playlist-export runs and operations.
- Nineteen forward migrations are applied. No migration was required during acceptance.
- Final aggregates: 984 artists, 530 releases, 860 tracks, 1,152 candidates, 1,152 evidence rows,
  974 feed items, and 9 manual match decisions.
- Spotify writes default off. When enabled, route, service, and provider-client layers enforce the
  single configured playlist, ownership, private and non-collaborative status, exact or manually
  confirmed matching, and add-only behavior.

## Verified

- The documented production app starts on `127.0.0.1:3000`, serves the database-backed feed with
  no browser-console errors, and preserves feed and review state across a full app/database restart.
- A bounded Spotify daily scan completed 15 artists, discovered 2 records, and inserted 2 records
  without a 429 or cooldown. `To My Core` appears with Spotify artwork and track evidence.
- A MusicBrainz scan completed all 6 confirmed mappings, discovered 4 records, and inserted 4
  records. Exact matches merged while `SEROTONIN` produced one canonical feed item with MusicBrainz
  evidence and no fabricated artwork.
- `Let Me Go - Bafu Remix` was confirmed through the review UI only after normalized title, version,
  duration, and complete artist credits agreed. The decision remained persisted after restart and
  the review card stayed closed.
- Source evidence and feed persistence are idempotent. Final duplicate checks found zero duplicate
  provider candidate IDs, evidence identities, feed candidate rows, or playlist-export IDs.
- Playlist work touched only `4l6LaMPL6duulmFe3hRR4Y`. A dry run found exactly 3 new eligible
  tracks: one new canonical Spotify track, one exact barcode/position match, and the manually
  confirmed review track.
- The incremental add-only export completed with 3 additions, 807 already present, 116 skips, 0
  failures, and 0 ordering conflicts. Readback and the final dry run report 810 eligible tracks,
  810 present, 811 total playlist items, 0 proposed additions, and 0 duplicate track IDs. The one
  unrelated existing playlist item was preserved.
- The 116 skips are 66 duplicate recording appearances and 50 records without a confirmed Spotify
  match. No unresolved or ineligible record was exported.
- Complete verification passes: formatting, lint, strict type checking, production build, 370 unit
  tests in 46 files, 96 PostgreSQL integration tests in 17 files, and 26 Playwright tests.
- `pnpm doctor` reports READY with 19 migrations, both Spotify playlist modification scopes, no
  cooldown, no stale lock, and the production app responding.

## Implemented But Partially Verified

- The Spotify rolling scheduler and campaign persistence are implemented and test-covered, but
  automatic execution remains disabled. Doctor reports 692 queued scheduler items.
- Apple Music public-catalog discovery is implemented and previously live-tested, but it is disabled
  in the current local configuration and was not part of this acceptance run.

## Provider And Policy State

- Spotify is connected with `user-follow-read`, `playlist-read-private`,
  `playlist-modify-private`, and `playlist-modify-public`. All requests use the PostgreSQL-backed
  global gate with concurrency one and the configured ten-second minimum interval.
- Requesting `playlist-modify-public` grants account-level OAuth permission only. Application code
  still cannot select another playlist or change playlist visibility.
- MusicBrainz is configured and verified. Apple Music is disabled. Reddit remains approval-gated,
  and SoundCloud automation remains excluded.

## Known Risks

- Spotify documents `playlist-modify-private` for private-playlist writes, but this Development Mode
  app returned HTTP 403 until the token also contained `playlist-modify-public`. The behavior is
  directly verified but remains a provider-documentation discrepancy.
- Serialized verification of an 800-item playlist takes several minutes at the required ten-second
  request interval. A local command timeout can expire while the durable exporter continues and
  finishes correctly; operational timeouts should be at least 15 minutes for full readback.
- There are 1,335 pending Apple Music mapping candidates. They remain unresolved and are excluded
  from automatic matching or export.
- Feed records without a confirmed Spotify track remain skipped until later exact matching or manual
  review resolves them.

## Immediate Next Step

Keep playlist export idle until a future dry run reports new eligible discoveries. The next product
decision is whether to enable the test-covered rolling Spotify scheduler or first reduce the Apple
Music mapping-review backlog.

## Deferred

- Any second playlist target, playlist picker, or automatic change to the allowed playlist.
- Playlist creation, deletion, rename, visibility changes, artwork, follow/unfollow, removal,
  replacement, reordering, or cleanup of user-added items.
- Combined playback, mixed-provider queues, SoundCloud automation, Reddit live access, YouTube,
  TIDAL, multi-user deployment, and commercial operation.
