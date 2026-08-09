# AI Handoff

Updated: 2026-08-08 22:27 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting checkpoint: `3416873bf7da`
- Current implementation checkpoint: this commit (`feat: order Spotify playlist by release date`)
- Current milestone: release-date Custom Order for the single authorized Spotify playlist
- Push target: `origin/codex/release-radar-hardening`
- Worktree after this checkpoint: clean except unrelated untracked `outputs/`, which remains excluded
- PostgreSQL: healthy with 29 applied forward migrations, including migration `0028`

## Verified

- The authorized private playlist contains 935 items before and after conversion. The same track,
  `added_at`, and `added_by` multisets were preserved, including one user-added item.
- The conversion used 473 snapshot-aware range moves: one canary and 472 remaining moves. It used no
  add, remove, replace, clear, visibility, playlist-selection, or playlist-creation request.
- The final release-date planner reports zero remaining moves. Releases are newest first and
  contiguous; album and EP tracks use disc then track order with deterministic same-date ties.
- The live canary preserved Spotify Date Added. The full conversion and resumed conversion preserved
  the same metadata and item count. An interrupted command resumed from the persisted snapshot and
  completed the remaining 52 moves.
- Snapshot-aware caching persists the verified ordered representation. The live validation sequence
  used 84 playlist reads and 473 writes with zero 429 responses. A subsequent unchanged-snapshot
  preview used one playlist metadata read and skipped all item pages.
- The existing guarded exporter inserts future additions at their chronological Custom Order
  positions and performs only the necessary range moves. It remains default-off and restricted to
  the configured authorized playlist.
- Formatting, lint, strict TypeScript, the 27-route production build, 454 unit tests across 61 files,
  137 PostgreSQL integration tests across 26 files, and all 30 Playwright tests pass. The test
  database rebuilt cleanly through all 29 migrations. Browser smoke renders the feed without a build
  or application error overlay.
- Doctor reports READY: no cooldown, no stale lock, 29 migrations, both playlist modification scopes,
  and the local application responding at `http://127.0.0.1:3000/#feed`.

## Partially Verified

- Thursday, Friday, and broad scheduled exports use the same tested exporter and Custom Order planner,
  but a complete recurring production week has not run unattended with this ordering policy.

## Operational State

- Spotify cooldown: none active. No operation lease or stale lock remains.
- Playlist cache: current and verified for the authorized playlist snapshot.
- A final guarded dry run found 24 newly eligible additions, 934 managed items already present, one
  unrelated user-added item, zero existing duplicates, and zero Custom Order moves. These additions
  were not exported by this milestone and remain for the normal scheduled exporter.
- Existing 54-item Apple-priority backlog, scheduler priorities, Artist Albums budgets, discovery
  behavior, and 429 policy are unchanged.

## Risks

- Spotify rate limits remain unpublished. The shared PostgreSQL gate and persisted cooldown are still
  required even though this conversion produced no 429 response.
- The first full conversion required 84 playlist reads because dry-run, canary readback, conversion,
  interruption recovery, and final verification each required safety reads. Normal unchanged-snapshot
  operation is one playlist metadata read with no item pagination.
- The `app:up:dev` wrapper can leak Windows child processes and handles; local smoke testing uses the
  hidden production server instead.

## Immediate Next Step

Allow the existing scheduler to export the 24 pending eligible additions through the same guarded
Custom Order path when its local production capabilities are enabled.

## Deferred

- Scheduler, Artist Albums budget, provider, discovery, or Apple-priority backlog changes
- Spotify pacing or quota-policy changes
- Deep historical reconciliation and inactive providers
