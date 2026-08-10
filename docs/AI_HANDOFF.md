# AI Handoff

Updated: 2026-08-09 22:05 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Current checkpoint: `HEAD` (`fix: restore playlist ordering and priority execution`)
- Upstream: current branch tracks `origin/codex/release-radar-hardening`
- Worktree: tracked files are clean; unrelated `outputs/` remains untracked and excluded
- Database: PostgreSQL healthy; all 29 forward migrations applied

## Current Milestone

Restore release-date Spotify Custom Order, separate playlist ownership from current export
eligibility, eliminate repeated full playlist reads, and preserve the intentional dynamic
Apple-priority scheduler and hidden Windows launcher changes.

## Verified

- The authorized Spotify playlist is public, non-collaborative, and contains 1,009 unique track IDs.
- Custom Order is newest release date first. Albums and EPs are contiguous in disc then track order.
  A complete live readback reports zero remaining reorder moves, zero duplicate IDs, zero unknown
  release dates, and zero noncontiguous release groups.
- Reordering used Spotify range moves only. No item was added, removed, or re-added. The pre/post
  provenance hash over track ID, Date Added, and Added By is unchanged.
- Playlist ownership is 1,008 app-managed items and one unmanaged item. The unmanaged item is Becky
  Hill, `>>>hands on me<<<`. The prior count of 42 described tracks outside the current eligibility
  set, not user-added tracks; all 42 have app-owned export-ledger rows.
- Internal additions and reorder moves persist the returned snapshot and known ordered cache. An
  unchanged snapshot requires one playlist metadata check and no item pagination. An external or
  interrupted-write snapshot change requires one complete reconciliation read.
- The final full reconciliation used 23 playlist reads: metadata before, 21 pages of up to 50 items,
  and metadata after. No 429 occurred. A normal unchanged-snapshot export used one playlist metadata
  read and no item pages.
- Reorder planning and the provider-client boundary cap ranges at 100 items. A live 113-item move was
  rejected with HTTP 400 after two earlier moves committed; the durable run resumed from that
  snapshot, split the range, and completed without replaying committed moves.
- Apple-priority scheduling can commit up to 10 priority items per process and immediately claim the
  next item. It retains one Spotify request at a time, at least 10 seconds between request starts,
  rolling 24-hour capacity, restart-safe progress, priority precedence, and immediate stop on 429 or
  capacity exhaustion. Credential-free five-item and ten-item canaries pass; broad work is excluded.
- Windows campaign registration uses hidden `conhost.exe --headless node.exe --import tsx` execution
  and does not register PowerShell or pnpm as the recurring task action.
- Browser smoke renders the live Discovery Feed without an application error overlay.

## Validation

- Format: passed
- Lint: passed with zero warnings
- Strict TypeScript: passed across six workspace projects
- Unit: 466 passed across 62 files
- PostgreSQL integration: 141 passed across 27 files
- Playwright: 30 passed
- Production build: passed
- Doctor: READY; no provider cooldown, stale lock, active lease, or pending playlist operation
- Migrations: all 29 applied
- Git diff check: passed

## Implemented But Not Live-Verified

- Dynamic multi-item Apple-priority execution has not made a live Spotify request because the live
  priority queue is empty. Its request gate and bounded single-item work were live-validated earlier.
- A complete unattended Thursday/Friday recurring production cycle remains unobserved.

## Operational State

- Spotify cooldown: none. The latest `quota_exceeded` was a playlist-read 429 with a 5,550-second
  Retry-After; it expired and was not cleared or bypassed.
- Apple-priority queue: empty.
- Playlist export: complete with zero pending operations.
- Broad Spotify backlog: present; broad reconciliation was not started during this correction.
- Automatic recurring execution remains disabled by default in repository and local configuration.
- Apple Music automatic discovery is currently disabled. Reddit and SoundCloud automation remain
  disabled.

## Risks

- Spotify rate limits remain unpublished. All Spotify work must continue through the shared
  PostgreSQL request gate and persisted cooldown.
- A crash between a successful provider write and local snapshot persistence requires one full
  playlist reconciliation after restart. The durable snapshot and export ledger make that recovery
  safe but relatively expensive for a 1,009-item playlist.
- The dynamic priority loop is covered by simulated canaries but still needs observation with a real
  nonempty Apple-priority queue.

## Immediate Next Step

Review the combined checkpoint, then begin broad Spotify reconciliation only through the existing
bounded scheduler and request budgets. Do not bypass the playlist cache or request gate.

## Deferred

- Live observation of a nonempty dynamic Apple-priority run
- Unattended Thursday/Friday recurring-cycle validation
- Deep historical reconciliation and inactive providers
