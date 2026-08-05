# AI Handoff

Updated: 2026-08-04 21:25 PDT (UTC-07:00)

This is the canonical repository and operational snapshot. It excludes credentials, tokens,
private keys, personal provider data, authorization headers, and raw provider payloads.

## Repository State

- Branch: `codex/release-radar-hardening`.
- Local HEAD: the checkpoint commit `feat: add guarded Spotify playlist export`. Its parent and
  pre-push upstream were `005e51ead1b3b9b4c3d8d1a6df258a34ad608db9`,
  `fix: handle Apple Music prerelease placeholders`.
- Worktree: clean after the checkpoint. No secret, local configuration, log, dump, backup,
  screenshot, trace, or temporary artifact is included.
- Current milestone: production Spotify add-only export to one configured owned private playlist;
  implementation is complete, but Spotify rejects the documented write request after clean OAuth.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, Node scanner and CLI, provider-neutral core,
  Drizzle/PostgreSQL persistence, Zod-validated provider clients, Vitest, and Playwright.
- PostgreSQL is authoritative for canonical releases, tracks, appearances, evidence, feed state,
  review decisions, request gates, cooldowns, and export state.
- Production has 19 applied forward migrations. Migration `0018_romantic_omega_red.sql` adds
  durable Spotify playlist-export runs and per-item operations.
- A pre-migration PostgreSQL custom-format backup was created outside source control on
  2026-08-04 at 14:39 PDT and verified with 440 archive entries.
- Spotify playlist writes still default to disabled. The ignored local `.env` is temporarily
  configured to enable writes only to the approved target; no credential or local configuration
  file is part of the repository change.

## Verified

- Canonical-feed export planner preserves followed-artist eligibility, exact or manually confirmed
  matching, remix and appearance records, deterministic newest-first release order, contiguous disc
  and track order, and relative order of user-added playlist items.
- Every browser and CLI live path derives its target only from `SPOTIFY_ALLOWED_PLAYLIST_ID`.
  Route, service, and provider-client guards reject disabled writes, malformed targets, target
  mismatch, missing write scope, wrong owner, public playlists, and collaborative playlists before
  addition.
- Only add-only playlist operations are implemented. Playlist create, select, rename, visibility change,
  artwork upload, follow, unfollow, remove, replace, reorder, and deletion remain unavailable.
- Dry run is read-only and reports the exact target, additions, skips and reasons, existing items,
  duplicates, and order conflicts. Live mode has a canary limit and a durable per-track ledger.
- Restart reconciliation reads the playlist before retrying, records provider-success/local-crash
  cases without duplicate writes, continues after isolated item errors, and stops on policy,
  authentication, 401, 403, or 429 failures.
- Live read-only target verification and dry run succeeded against the approved target: 808 eligible
  additions, 115 skips, 65 duplicate recording appearances, 50 missing Spotify matches, zero
  existing duplicates, and zero order conflicts.
- Final credential-free verification passes: formatting, lint, strict type checking, production
  build, 368 unit tests in 46 files, 95 PostgreSQL integration tests in 17 files, and 26 Playwright
  tests. One parallel Playwright timing failure passed in isolation and the complete 26-test suite
  then passed on rerun.
- The migration verifier completed successfully and `pnpm doctor` reports READY with 19 migrations,
  no stale lock, and no Spotify cooldown.
- The client retains only bounded provider reason tokens and allowlisted error categories; raw
  Spotify error messages and payloads remain discarded.
- A completely clean OAuth authorization completed at 2026-08-04 21:07 PDT after the prior access
  and refresh tokens were retired. The authorization URL used the configured Client ID and exact
  callback, requested `user-follow-read`, `playlist-read-private`, and
  `playlist-modify-private`, and set `show_dialog=true`. The callback stored the newly issued access
  and refresh tokens through the encrypted account repository.
- A one-track direct canary outside export orchestration used one in-memory access token for
  `GET /me`, `GET /playlists/{id}`, and `POST /playlists/{id}/items`. The two reads returned 200,
  `/me.id` matched `playlist.owner.id`, and the playlist was private and non-collaborative. The POST
  still returned 403 with the allowlisted classification `insufficient_scope`. The token fingerprint
  was identical across all three calls; Spotify returned no request-ID or `WWW-Authenticate` header.
- The direct append body contained one already-selected pending Spotify URI and omitted `position`.
  This rules out the exporter's optional positional field as the source of the rejection. Readback
  and the durable ledger still show zero additions.

## Implemented But Not Live-Verified

- The complete export, post-export order audit, and second-run idempotency check remain blocked.
- The three-item exporter canary and the post-reauthorization one-item direct canary were attempted
  with positional and append request shapes. Spotify returned HTTP 403 `insufficient_scope` every
  time. Playlist readback and the application ledger both confirm that zero tracks were added.
- The partial export run remains durable and resumable: 808 add operations are pending, 115 skip
  operations are recorded, and the application-owned export ledger is empty.

## Provider And Policy State

- Spotify has no active cooldown. Development Mode quota remains unpublished and all token and Web
  API requests use the PostgreSQL-backed ten-second global request gate.
- Official Spotify documentation rechecked on 2026-08-04 still identifies
  `playlist-modify-private` as the correct scope and `POST /playlists/{id}/items` with a JSON `uris`
  array as the correct request for an owned private playlist. The provider response contradicts the
  fresh token's returned scope list and the verified target identity.
- Spotify playlist permission is account-wide. Application allowlisting narrows behavior to one
  target but does not narrow the OAuth grant itself. Spotify's broad cross-service policy language
  remains unresolved.
- Apple Music public catalog and MusicBrainz remain independent. Reddit remains approval-gated.
  SoundCloud automation, YouTube, and TIDAL remain excluded or deferred.

## Known Risks

- Live addition is blocked by Spotify HTTP 403 `insufficient_scope` despite a freshly authorized
  token that reports the documented private-playlist scope. The exact app, Premium owner or
  allowlisted user, callback, and playlist owner were verified in Spotify Developer Dashboard. The
  remaining restriction is provider-side and is not exposed by Spotify's response or documentation.
- Existing playlist order conflicts can only be reported, not repaired, because automatic reorder
  is prohibited.
- Records without a confirmed Spotify track are skipped and reconsidered by later exports after the
  matching or review workflow resolves them.

## Immediate Next Step

Checkpoint the complete guarded exporter. Do not issue another playlist write until Spotify support
or a documented platform change explains why a freshly consented Development Mode user token with
`playlist-modify-private` receives `Insufficient client scope` on the documented endpoint. When that
external blocker is resolved, resume the existing 808-operation run with the three-item canary; do
not recreate the run or select another playlist.

## Deferred

- Any second playlist target or playlist picker.
- Playlist creation, deletion, rename, visibility changes, artwork, follow/unfollow, removal,
  replacement, reordering, or automatic cleanup of user-added items.
- Combined playback, mixed-provider queues, SoundCloud automation, Reddit live access, YouTube,
  TIDAL, multi-user deployment, and commercial operation.
