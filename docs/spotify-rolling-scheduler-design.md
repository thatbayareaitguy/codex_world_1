# Spotify Rolling Scheduler Design

Verified: 2026-07-22

Status: designed, not implemented, not live-provider tested, and not proven at scale.

This document defines one durable scheduler for initial synchronization and normal recurring
Spotify discovery. It does not authorize provider requests, playlist access, Batch 3 work, or a
runtime configuration change.

## Verified Baseline

- Branch `codex/release-radar-hardening` is clean at
  `59c9df5ee532dd7658013582b6cef1652f69a614` and is synchronized with its upstream.
- Application checkpoint `6498ca8d1705fe49c59734b4a8b1fac005b7d356` is an ancestor of HEAD.
- PostgreSQL is healthy with 14 forward migrations. Doctor reports `READY`.
- No active or stale operation lock, scan lock, Spotify request lease, or queue entry exists.
- The stored Spotify cooldown has expired. Playlist writes are disabled and no playlist target is
  configured.
- The active target is 593 artists. All 593 have confirmed Spotify IDs.
- 101 artists have a successful persisted live artist outcome and 492 have none. The newer
  page-level table contains page telemetry for 36 of the 101 outcomes, including 30 non-dry
  outcomes, so initial due-time backfill cannot depend only on `spotify_page_scans`.
- Batch 2 is complete. Batch 3 remains untouched with 15 pending artists and zero requests.
- Album retrieval is healthy: 93 complete, zero partial, zero awaiting resume, zero missing tracks,
  and zero discrepancies.
- Current safe telemetry contains 297 Spotify request events in the preceding 24 hours and zero in
  the preceding 30 minutes. The 24-hour endpoint counts are 63 artist catalog, 147 album detail,
  80 album-track, and 7 OAuth requests. One historical 429 falls inside that 24-hour window, but
  its cooldown is no longer active.
- The latest successful outcome per scanned artist has a mean of 1.95 discovery requests, median
  2, p95 4, and maximum 10. OAuth requests are recorded separately in the global event ledger.

These counts are point-in-time operational evidence. They are not a Spotify quota or a promise of
future request volume.

## Evidence Map

| Responsibility                      | Current component                                                                                                                                                                                            | Scheduler use                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Batch planning and persisted order  | `apps/scanner/src/spotify-scan-plan.ts`: `prepareSpotifyWork`, `selectSpotifyBatchMappings`; `packages/db/src/spotify-batches.ts`: `createSpotifyScanBatch`, `claimNextSpotifyArtist`                        | Preserve for manual and staged batches. Do not use it as the recurring due-time scheduler.                                       |
| Page-one and deeper artist scans    | `packages/providers/src/spotify-provider.ts`: `SpotifyProvider.scan`; `SpotifyClient.getArtistAlbumsPage`                                                                                                    | Reuse request and response validation. Split page acquisition from inline album detail fan-out for scheduler work.               |
| Artist catalog cursor               | `spotify_artist_coverage`, `spotify_page_scans`; `prepareSpotifyCoverage`, `recordSpotifyPage`, `markSpotifyCoverageInterrupted`                                                                             | Remain authoritative for page-one success, reconciliation offset, partial state, and page history.                               |
| Known catalog summaries             | `spotify_catalog_releases`; `loadSpotifyCatalogSummaries`, `spotifyCatalogSummaryHash`                                                                                                                       | Continue preventing unchanged releases from creating detail work.                                                                |
| Album detail and candidate creation | `SpotifyProvider.scanAlbum`; `apps/scanner/src/scan.ts`: `persistCandidates`                                                                                                                                 | Extract a reusable detail-stage processor without changing matching or persistence behavior.                                     |
| Album-track resume and completeness | `spotify_release_track_retrievals`, `spotify_release_track_pages`, `spotify_release_track_items`; `startSpotifyReleaseTrackRetrieval`, `recordSpotifyReleaseTrackPage`, `markSpotifyReleaseTrackInterrupted` | Remain authoritative for every track page, cursor, disc and track order, count, error, and completion state.                     |
| Release-only repair                 | `apps/scanner/src/spotify-release-reconciliation.ts`: `runSpotifyReleaseReconciliation`                                                                                                                      | Reuse page validation and resume rules. Scheduled track work must use the same repository functions.                             |
| Request serialization               | `packages/db/src/spotify-request-gate.ts`: `createSpotifyRequestGate`, `acquireSpotifyPermit`, `completeSpotifyRequest`                                                                                      | Reuse as the only Spotify request path. Raise the future global minimum to 10 seconds.                                           |
| Cooldown                            | `spotify_provider_state`; `getSpotifyOperationalStatus`, `SpotifyCooldownError`                                                                                                                              | Reuse unchanged. A valid cooldown preempts all scheduler work and survives restart.                                              |
| Request telemetry                   | `spotify_request_events`                                                                                                                                                                                     | Reuse for rolling counts, queue waits, endpoint categories, 429s, and cooldown evidence. Add scheduler work context.             |
| Global operation lock               | `operation_locks`; `acquireOperationLock`, `heartbeatOperationLock`, `releaseOperationLock`                                                                                                                  | Reuse `scan:global` so scheduled and manual scans cannot overlap.                                                                |
| Provider persistence lock           | `scan_locks`; `withScanLock` in `apps/scanner/src/scan.ts`                                                                                                                                                   | Reuse while canonical candidates are persisted.                                                                                  |
| Pause, cancel, retry, resume        | `spotify_scan_batches`, `spotify_artist_scans`; batch repository functions; operation-lock cancellation                                                                                                      | Preserve for manual batches. Scheduler pause and resume use scheduler state and cooperative tick cancellation.                   |
| Request budget                      | `budgetSpotifyRequestGate`, `SpotifyRequestBudgetError` in `apps/scanner/src/scan.ts`                                                                                                                        | Reuse the hard per-process guard and add rolling 30-minute and 24-hour guards.                                                   |
| Scan status API                     | `apps/web/app/api/scans/route.ts`, `apps/web/app/api/system/status/route.ts`, `apps/web/app/api/spotify/status/route.ts`                                                                                     | Extend with scheduler state and bounded aggregate metrics.                                                                       |
| UI status and history               | `apps/web/app/radar-shell.tsx` Spotify scan and scan-history panels                                                                                                                                          | Add a scheduler panel without removing manual batch history.                                                                     |
| Local launch                        | `apps/web/lib/scan-launcher.ts`, `apps/scanner/src/app-ops.ts`, `scripts/run-daily-scan.ps1`                                                                                                                 | Reuse hidden Windows process launching and external Task Scheduler. Replace daily burst scheduling with a bounded periodic tick. |

## Selected Process Model

### Options considered

**Continuously running worker**

- Advantages: low dispatch latency and fewer process starts.
- Costs: requires a new supervised service, PID lifecycle, restart policy, log rotation, and changes
  to `app:up` and `app:down`. An in-memory timer is also unnecessary because PostgreSQL must remain
  authoritative after restart.

**Short-lived periodic tick**

- Advantages: matches the existing Windows Task Scheduler architecture, recovers naturally from
  process exit, and makes runtime, artist, and request bounds explicit.
- Costs: process startup overhead and reliance on an external one-minute trigger.

### Decision

Use a short-lived Spotify scheduler tick invoked every minute by Windows Task Scheduler. The task
uses the existing hidden Windows launch pattern and the repository `.env`; no secret is placed in
the task definition. Configure Task Scheduler to avoid starting a second instance. PostgreSQL is
still the enforcement authority if two ticks overlap.

Each tick must:

1. Exit without a provider request unless scheduler mode permits work.
2. Acquire the existing `scan:global` operation lock or exit as already running.
3. Inspect the global cooldown and rolling request budgets before claiming work.
4. Recover only expired scheduler work leases.
5. Touch at most one distinct artist, start at most six Spotify requests, and run at most 90
   seconds.
6. Persist after every request stage and release its work lease and operation lock before exit.

The tick interval is one minute, but the base-artist slot gate prevents one artist from being
started every minute. At 593 eligible artists, the nominal slot is `24 hours / 593`, about 146
seconds. After downtime, the next slot is based on the current time rather than an old missed slot,
so the worker never performs a catch-up burst.

## Durable Work Model

Existing tables persist provider and canonical progress, but they do not provide one claimable,
due-time ordered work list across base checks, release details, track pages, and reconciliation. A
forward migration is required.

### New singleton state

Add `spotify_scheduler_state` with one `global` row:

- `mode`: `disabled`, `planning`, `validation`, `automatic`, or `paused`
- `next_base_slot_at`
- `cycle_started_at` and `cycle_target_artists`
- `last_tick_started_at`, `last_tick_completed_at`, and `last_tick_error_classification`
- `effective_configuration`: a secret-free snapshot of tick limits, rolling budgets, request
  interval, and window length
- standard `updated_at`

`disabled` is the database default. Environment capability and database mode must both allow live
work. Planning mode performs database selection and estimates only. Validation mode processes only
an explicitly persisted validation scope. Automatic mode uses the active confirmed watchlist.

### New durable work table

Add `spotify_scheduler_work`:

- `id` and unique deterministic `work_key`
- `work_type`: `base_artist`, `release_detail`, `release_tracks`, or
  `artist_reconciliation`
- `status`: `queued`, `leased`, `blocked`, `completed`, or `cancelled`
- nullable `artist_id`, `spotify_album_id`, `release_track_retrieval_id`, and
  `reconciliation_cycle_id`
- `source`: `initial`, `recurring`, `validation`, or `repair`
- `priority`, `due_at`, and `not_before`
- `attempt_count`, `last_error_classification`, `last_started_at`, and `last_completed_at`
- `lease_owner` and `lease_expires_at`
- standard creation and update timestamps

Use check constraints so each work type has the required target. Keep offsets, fetched counts, and
completion truth in their current authoritative tables rather than copying them into the work row.

Required indexes:

- unique `work_key`
- `(status, due_at, priority, id)` for deterministic due work
- `(work_type, status, due_at, id)` for backlog and priority selection
- `(lease_expires_at)` for expired-lease recovery
- `(artist_id, status)` for watchlist changes and per-artist observability
- `(spotify_album_id, work_type)` for idempotent release work

### Request context

Add nullable `scheduler_work_id` and `scheduler_work_type` to `spotify_request_events`, with an
index on `(scheduler_work_type, started_at)`. Endpoint category remains the network-operation
classification. Work type distinguishes page-one artist requests from deeper artist reconciliation
without exposing provider URLs or payloads.

### State transitions

| Work           | Success                                                                                                        | Retryable failure                                                 | Safety or identity block                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------ |
| Base artist    | Update `daily_scan_completed_at`; requeue the same work for completion time plus 24 hours                      | Requeue with bounded `not_before`; do not advance successful time | Block while inactive, disabled, unmapped, or mapping-changed |
| Release detail | Persist album fields and embedded first track page; complete detail work; queue track continuation when needed | Requeue without losing the catalog summary or retrieval state     | Block malformed or identity-conflicting work for review      |
| Release tracks | Persist one page; requeue at retained offset or complete at terminal validated count                           | Requeue from `spotify_release_track_retrievals.next_offset`       | Block terminal count or mapping discrepancy until repair     |
| Reconciliation | Persist one artist catalog page; requeue at `spotify_artist_coverage.next_offset` or complete the cycle        | Requeue from retained offset                                      | Block missing or changed artist mapping                      |

A lease transition is one conditional `UPDATE ... WHERE status = 'queued' AND due_at <= now() AND
(not_before IS NULL OR not_before <= now()) RETURNING ...` inside a transaction. Selection uses
`FOR UPDATE SKIP LOCKED`. An expired `leased` row returns to `queued` without changing its provider
cursor. No database transaction remains open while waiting for request pacing.

## Eligibility And Due Times

The daily target is recalculated from active `artist_follows` joined to confirmed Spotify
`artist_external_ids`. Provider source and manual or imported origin do not affect eligibility.

For each active mapped artist:

1. Use `spotify_artist_coverage.daily_scan_completed_at` when present.
2. During migration backfill only, fall back to the latest completed or partial non-dry
   `spotify_artist_scans.finished_at`. This preserves the 101 known successful outcomes even though
   older rows predate complete page telemetry.
3. Set `nextDueAt` to the last successful page-one time plus 24 hours.
4. If no successful time exists, the artist is due immediately.

Select the most overdue eligible artist with stable ordering:

```text
due_at ASC NULLS FIRST, followed_at ASC, artist_id ASC
```

Additional rules:

- Newly followed and manually added artists become due when a confirmed Spotify mapping exists.
- A bulk import may make many rows due, but the global base-slot gate still admits only one per
  current slot.
- Unfollowed or inactive artists have queued work cancelled and an active lease allowed to finish
  only its current request. No next request starts for that artist.
- Missing or changed mappings block work through the existing mapping checks. Confirmation makes
  it eligible again without resetting persisted cursors.
- A successful page-one check counts as daily completion even when another catalog page exists.
  The artist remains partial and receives reconciliation work.
- Provider disablement or scheduler pause leaves work durable but ineligible.
- A retryable non-429 failure uses bounded scheduler retry delays of 15 minutes, one hour, then six
  hours. Provider-client transient retries remain bounded inside the current request path.
- A 429 does not use this local retry schedule. The global provider cooldown is the only resume
  authority.

## Priority And Starvation Rules

Every work choice is made from PostgreSQL again. Process memory never owns the queue order.

1. Active cooldown, disabled provider, disabled scheduler, exhausted rolling budget, or lost global
   lock preempts all Spotify work.
2. When the base slot is open, the most overdue base artist is selected before detail or
   reconciliation work.
3. Between base slots, an already-started partial album-track chain is the highest urgent work.
4. New-release detail is next. Process at most two urgent detail or track requests before
   reevaluating base eligibility and projected coverage.
5. If no urgent release work exists, another base artist may run only when its slot is open. The
   worker never advances `next_base_slot_at` to catch up missed slots.
6. Reconciliation runs only when no urgent release work exists, the next base slot has enough time
   for one request plus a safety margin, and the remaining rolling request budget is greater than
   the minimum requests needed by remaining base work.
7. Reconciliation stops immediately when a base deadline becomes eligible. It can never consume
   the reserved base request count.

The scheduler uses one artist per invocation. Child release work for that artist may use remaining
request and runtime allowance. Other artists wait for a later tick. This preserves a bounded detail
chain without allowing one large catalog to monopolize the worker.

## Initial Synchronization

Initial synchronization is not a separate batch algorithm. Enabling the initial rollout
idempotently creates or refreshes one base work row for every active confirmed artist.

- The 492 never-successful artists are immediately due.
- The 101 successful artists receive due times from their latest successful page-one evidence.
- Stable database ordering selects among all due artists.
- `next_base_slot_at` permits one base artist about every 146 seconds at the current target.
- A restart loses no work because due times, leases, catalog pages, release pages, and request
  cooldowns are persisted.
- A cooldown leaves every job queued. After valid expiration, a later tick resumes automatically
  at the same provider cursor and normal slot cadence.
- A backlog changes the estimate and overdue count. It does not increase request concurrency or
  compress missed slots.

Batch 3 is not consumed, changed, or cancelled by this design milestone. Before automatic rollout,
the user must decide whether its 15 pending rows become the explicit validation cohort or remain
preserved as a superseded manual batch. No silent dual processing is allowed.

## Album Completeness Invariants

Scheduled release work preserves the current invariants:

1. A detail request records expected `total_tracks`, canonical release linkage, and the embedded
   first track page before another page request starts.
2. Each subsequent `tracks.next` page is requested at the persisted offset.
3. `spotify_release_track_pages` records each completed offset independently and idempotently.
4. `spotify_release_track_items` deduplicates provider track IDs while preserving disc number and
   track number.
5. Multi-disc order is `(disc_number, track_number)` and must remain monotonic inside each response
   page.
6. A terminal response is complete only when the unique fetched count equals Spotify
   `total_tracks`, every page has no unresolved error, and no next cursor remains.
7. A malformed cursor, missing page, missing canonical mapping, count mismatch, or unresolved error
   leaves the retrieval partial or blocked with its recovery evidence intact.
8. An interruption resumes from the last completed page. It never restarts completed pages merely
   because the process restarted.

An interrupted release chain is urgent work, but only two urgent requests may run before base
coverage is reevaluated. The 90-second invocation limit also ends before the current 146-second
base slot at the current artist count.

## Safety Model

- `SPOTIFY_SCHEDULER_ENABLED` must default to `false`. Database mode also defaults to `disabled`.
- Planning mode reads due work and estimates only. It does not construct a Spotify client or token
  manager.
- Future scheduler configuration must enforce global Spotify concurrency one and reject any
  request-start interval below 10,000 ms in both provider configuration and the request gate.
- Initial scheduler limits are one artist, six total Spotify requests, and 90 seconds per tick.
- Initial local rolling safety budgets are 30 requests per 30 minutes and 1,200 requests per 24
  hours. These are application safety ceilings based on current evidence, not claims about a
  Spotify quota. Any increase requires separate review and live evidence.
- OAuth token requests count against request and runtime limits because they use the same gate.
- HTTP 429 stops the tick immediately. `Retry-After` is persisted by the current cooldown system.
- No tick probes, clears, shortens, or bypasses a cooldown. Cancellation clears local timers only.
- Expired cooldown makes queued work eligible automatically; it does not force an immediate burst.
- Validation mode accepts only a persisted, explicitly confirmed ten-artist scope. It cannot fall
  through to the general watchlist.
- Automatic mode is a separate explicit approval after validation. Implementation and tests never
  enable it.
- Playlist writes remain disabled. Scheduler code does not construct a playlist client or call a
  playlist endpoint.

## Capacity And Estimates

Base coverage and total request load are different quantities:

- Base minimum: 593 artist-catalog requests per rolling 24 hours at the current target.
- Nominal base cadence: about one artist every 146 seconds.
- Current observed discovery outcomes: mean 1.95, median 2, p95 4, and maximum 10 requests per
  scanned artist. These historical counts reflect the existing inline detail path and must not be
  treated as fixed scheduler costs.
- A 1,200-request local 24-hour ceiling reserves at least 607 requests beyond the current base
  minimum. Detail or reconciliation work that does not fit carries forward.
- At the required 10-second spacing, 593 request starts require at least about 1.65 request-hours.
  A 950 to 1,200 request planning range requires about 2.6 to 3.3 request-hours, distributed across
  the day rather than run consecutively.

The status projection defines:

- `target`: active artists with confirmed Spotify IDs
- `current`: base checks completed in the preceding 24 hours
- `due`: eligible base work with `due_at <= now()`
- `overdue`: due work whose age exceeds one current base slot
- `blocked`: inactive, disabled, mapping-blocked, cooldown-blocked, or safety-budget-blocked work
- `partial`: artists with a retained deeper catalog cursor
- `completed`: releases with validated terminal track retrieval, plus artists fully reconciled in
  the current reconciliation cycle

Estimates are ranges based on due work, p50 and p95 observed requests, the 10-second gate, the next
base slot, rolling local budgets, and current detail backlog. During cooldown, the lower bound moves
to cooldown expiration and the backlog duration is added. During an indefinite cooldown or
provider failure, completion is `unavailable`, not a fabricated timestamp. The UI must never claim
guaranteed 24-hour completion.

## Observability And UI

Extend the existing `/api/scans` response with a bounded `spotify.scheduler` projection:

- mode, provider-blocked reason, last tick, and next base slot
- target, current, due, overdue, blocked, and partial artist counts
- artists checked in the last hour and last 24 hours
- oldest overdue age
- base, release-detail, release-track, and reconciliation backlog
- current leased work type, abbreviated target label, and lease expiry
- base, detail, track, reconciliation, OAuth, and total request counts for 30 minutes and 24 hours
- requests per completed base artist for the same windows
- 429 count, active cooldown, and accumulated cooldown duration
- estimated completion range and the factors that make it unavailable

`spotify_request_events` supplies network counts. Scheduler work context separates base and
reconciliation requests that share the `artist_albums` endpoint category. Work and coverage tables
supply backlog and due counts. No provider request is needed to render status.

Add a collapsible scheduler section to the existing Spotify status UI. Planning, validation,
pause, and automatic enable actions require same-origin validation, explicit confirmation, visible
disabled reasons, and no browser-supplied request limits. Extend system status to report
`external_periodic_tick` rather than claiming the application supervises a worker.

No-op ticks do not create scan-history rows. At each 24-hour scheduler window boundary, write one
aggregate `scan_runs` history record with trigger type `spotify_scheduler_window`; live progress
comes from scheduler state and work leases. This avoids hundreds of permanent history rows per day.

## Minimal Future Implementation Plan

### Forward migration required

Create the next forward migration only during implementation:

- add scheduler mode, work type, and work status enums
- create `spotify_scheduler_state` and `spotify_scheduler_work`
- add scheduler context columns and index to `spotify_request_events`
- seed one scheduler state row in disabled mode
- idempotently seed base work from active confirmed mappings
- backfill successful time from `daily_scan_completed_at`, then latest successful non-dry artist
  outcome, leaving never-successful artists due

Do not rewrite migrations `0000` through `0013`.

### New files

- `packages/db/src/spotify-scheduler.ts`: due projection, transactional claim, lease recovery,
  state transitions, rolling metrics, and window summaries
- `apps/scanner/src/spotify-scheduler.ts`: bounded dispatch loop and priority policy
- `apps/scanner/src/spotify-scheduler-cli.ts`: `plan` and `tick` entry points
- `scripts/run-spotify-scheduler-tick.ps1`: Windows-compatible hidden, logged invocation
- unit and PostgreSQL integration tests beside the new modules

### Direct modifications

- `packages/db/src/schema.ts` and `packages/db/src/index.ts`: future schema and repository exports
- `packages/providers/src/config.ts`: default-off scheduler limits and a global 10-second minimum
- `packages/db/src/spotify-request-gate.ts`: enforce 10 seconds and persist optional scheduler work
  context
- `packages/providers/src/spotify-provider.ts`: expose catalog-page and release-detail stages while
  retaining current validation and candidate construction
- `apps/scanner/src/scan.ts`: extract candidate persistence for reuse; keep manual batch behavior
- root `package.json`: add `spotify:scheduler:plan` and `spotify:scheduler:tick`
- `apps/scanner/src/doctor.ts`: scheduler mode, stale work lease, rolling budget, and backlog checks
- `apps/web/app/api/scans/route.ts` and `apps/web/app/api/system/status/route.ts`: scheduler status
- a guarded scheduler control route for planning, validation, pause, and automatic mode
- `apps/web/app/radar-shell.tsx` and `apps/web/app/globals.css`: scheduler status and controls
- README, daily-use, deployment, troubleshooting, architecture, data-model, security, and handoff
  documentation

Manual batch APIs and `spotify_scan_batches` remain available for diagnostics and explicitly
approved staged validation. They are not replaced by the scheduler.

## Credential-Free Test Matrix

Use fake time, injected HTTP handlers, synthetic artist IDs, and an isolated PostgreSQL database.
Normal tests must never construct live provider credentials.

| Behavior                   | Required assertion                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Most-overdue selection     | Earliest due row wins regardless of insertion order.                                        |
| Never-scanned stability    | Null-success artists order by followed time and stable artist ID.                           |
| Rolling due calculation    | Success at time T produces due time T plus 24 hours.                                        |
| Dynamic watchlist          | Additions become due; inactive or removed artists cannot be claimed.                        |
| Mapping state              | Missing and changed IDs block; restoring the expected ID requeues without cursor loss.      |
| Overlapping ticks          | One global operation lock and conditional work lease permit only one claimant.              |
| Lease expiry               | Crash leaves progress intact; a later tick requeues only after lease expiry.                |
| Process restart            | Next tick reads due time and provider cursor from PostgreSQL, not process memory.           |
| HTTP 429                   | First 429 stops all work and persists cooldown and safe event telemetry.                    |
| Cooldown                   | No request occurs before expiration; the first later tick resumes at normal cadence.        |
| Bounds                     | One artist, six requests, 90 seconds, 30-minute cap, and 24-hour cap each stop cleanly.     |
| Detail interruption        | Album detail resumes without losing the catalog summary or duplicating a candidate.         |
| Track interruption         | Completed offsets remain; resume starts at the stored next offset.                          |
| Multi-page album           | Every page persists once and completion waits for terminal cursor.                          |
| Multi-disc album           | Disc and track positions remain ordered and idempotent.                                     |
| Count mismatch             | Terminal page with fetched count different from `total_tracks` stays incomplete.            |
| Base starvation            | Due base work preempts detail after the bounded two-request slice.                          |
| Reconciliation suppression | Reconciliation cannot claim while urgent detail exists or base projection is unsafe.        |
| Idempotency                | Repeated ticks create no duplicate work, provider IDs, candidates, evidence, or feed rows.  |
| Planning mode              | Due projection and estimates run with zero token or provider-client construction.           |
| Validation scope           | Exactly the approved ten artists are eligible; general work remains blocked.                |
| UI and API                 | Status shows loading, empty, blocked, cooldown, lease, backlog, estimate, and error states. |
| Windows launcher           | Tick starts hidden with bounded arguments and uses no secret in the task definition.        |

Run formatting, lint, strict TypeScript, unit tests, clean and upgrade migrations, PostgreSQL
integration tests, production build, Playwright, doctor, and `git diff --check` before handoff.

## Rollout Gates

### Gate 1: implementation only

- Implement the forward migration, planning mode, worker, status, and tests.
- Keep scheduler capability and database mode disabled.
- Run all credential-free verification with zero live provider and playlist requests.
- Verify planning output against current PostgreSQL counts.

### Gate 2: explicitly approved ten-artist validation

- Require a printed ten-artist internal scope and separate user approval.
- Use validation mode, 10-second pacing, concurrency one, and all tick bounds.
- Stop on the first 429, cooldown, lease defect, duplicate, or persistence defect.
- Batch 3 may be used only if the approval explicitly says so.

### Gate 3: remaining initial watchlist

- Enable automatic mode only after Gate 2 passes and a second explicit approval is recorded.
- Seed all active confirmed artists into the same base work table.
- Spread never-successful artists by the dynamic base slot. Do not launch a batch burst.
- Report backlog and estimated range; do not promise 24-hour completion.

### Gate 4: sustained daily feasibility

- Observe at least three complete rolling 24-hour windows.
- Confirm base coverage, request counts, cooldown behavior, restart recovery, detail backlog, and
  reconciliation suppression.
- Do not raise budgets or lower pacing during this gate.

### Gate 5: post-sync cleanup

- Audit unresolved work, partial catalogs, release discrepancies, review items, and duplicate
  constraints.
- Decide the preserved Batch 3 treatment from database evidence. Do not delete history.
- Verify backup and restore, update operations documentation, and create the final checkpoint.

## Rollback

Set database scheduler mode to `paused` or disable scheduler capability. Disable the external Task
Scheduler entry. Do not delete queued work, cursors, cooldowns, request events, or completed pages.
An in-flight request finishes or is cooperatively cancelled; its lease then expires or is released.
Manual read-only scans remain available after the global operation lock is free.

The forward migration remains applied during rollback. Runtime rollback reads no new work and does
not rewrite migration history.

## Risks And Unresolved Decisions

- Spotify's Development Mode limit is unpublished. The selected local budgets reduce burst risk but
  cannot guarantee absence of 429 responses.
- Artist-album ordering is not guaranteed. Daily page one is a recall-oriented check, not catalog
  completeness; reconciliation remains necessary.
- A sleeping or powered-off Windows host misses ticks. Recovery preserves work but deliberately
  avoids a catch-up burst, so overdue completion may exceed 24 hours.
- The 1,200-request ceiling is an application safety choice. Gate 4 must establish whether it leaves
  a sustainable detail backlog without changing the ten-second pace.
- Existing successful history predates full page telemetry for some artists. The migration backfill
  must preserve 101 known outcomes while making later coverage records authoritative.
- The user must decide whether the untouched 15-artist Batch 3 becomes the ten-artist validation
  source or remains a preserved manual artifact.
- The user must approve automatic mode separately after validation. Scheduler implementation alone
  does not authorize the remaining watchlist.
