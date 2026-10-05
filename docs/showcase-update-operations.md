# Showcase budgeted updates

Updated: 2026-10-04 Pacific

## Architecture

The scanner continues its existing discovery and matching schedules. A separate local Showcase
job reads persisted scanner results in a read-only transaction, validates the public v3 contract,
applies authoritative editorial genres, and publishes through the restricted Neon function.
It never launches a scanner batch or writes a Spotify playlist.

The public website no longer queries Neon for visits or ISR. Before a Vercel build, one read of
`showcase.current_catalog` validates the contract and content hash, then writes a deployment-local
JSON snapshot. Pages read that snapshot. Date-sensitive pages regenerate at most hourly when
requested, without querying Neon. Release dates determine upcoming/released state; the home page's
recent-discovery window advances with the date, not the last publication timestamp.

Neon or build failure rejects the new deployment. The previous Vercel deployment stays available.
`/api/catalog-status` exposes only the public snapshot hash, publication time, counts, and the
runtime's zero-database-read design. It contains no credentials, operational evidence, or source IDs.

## Schedule and readiness

Dedicated Windows task: `Showcase Weekly Publication`.

- Friday 23:00 Pacific: primary weekly publication after Friday matching.
- Saturday 00:45 Pacific: retry and late-result check.
- Saturday 11:00 Pacific: final catch-up for late matches.
- Logon: catch up the latest missed slot only if it is less than 24 hours old.

Windows must use Pacific Time and the user must be signed in. Wake from sleep is requested; a
powered-off or signed-out PC cannot publish. DST is handled by Windows and America/Los_Angeles.
The recurring action is `conhost.exe --headless node.exe --import tsx`, not a PowerShell runner.
Scanner task definitions are unchanged.

Publication defers while an Apple batch is running, or when no error-free completed Apple batch
exists within two days (seven days for a manual update). This is a freshness gate, not a claim that
Spotify matching has no backlog. Available persisted exact/manual Spotify links publish with Apple
records; unmatched releases remain eligible, with a later catch-up adding newly resolved links.

Timestamp-only changes do not create Neon versions, fetch Feed artwork, or deploy again. Previously
validated artwork is reused only for the identical Apple Music release URL. Missing artwork is
looked up through the existing Feed mechanism during a changed publication, with a 20-minute data
fetch deadline. Feed failure preserves known artwork and neutral placeholders.

Empty catalogs, count drops over 10%, unresolved artist references, and oversized catalogs fail
closed. Scheduled runs also refuse uncommitted code or untracked files. Generated public JSON,
confirmed editorial genres, and Next's generated type declaration are the only dirty-file exceptions.

## Transfer safeguards

Neon Free allowance: 5 GB monthly public network transfer, per the
[official plans documentation](https://github.com/neondatabase/website/blob/main/content/docs/introduction/plans.md).
This implementation uses decimal bytes and deliberately does not allocate 1.2 GB every week:
31 days would average over 5 GB at that pace.

| Control                                   | Limit                                                 |
| ----------------------------------------- | ----------------------------------------------------- |
| Runtime Neon reads from public visits     | Zero                                                  |
| Maximum catalog returned by one Neon read | 8 MB, checked inside SQL                              |
| Publisher compact JSON size               | 4 MB, leaving jsonb serialization headroom            |
| Reservation before each update attempt    | 32 MB                                                 |
| Attempts per rolling seven days           | 8 maximum, including failures                         |
| Rolling seven-day transfer budget         | 750 MB                                                |
| Calendar-month transfer budget            | 3.5 GB                                                |
| October initial usage baseline            | 2 GB, rounded up from the supplied 1.87 GB screenshot |

Three full reads are possible per successful changed update: prior catalog, publication readback,
and cloud build. Their combined upper bound is 24 MB; the reservation leaves another 8 MB for
protocol and small verification responses. At eight attempts, the current job is limited to
256 MB reserved per rolling week. The normal three scheduled attempts reserve 96 MB. Reservations
are intentionally not refunded for skips or errors.

This is a conservative application ledger, **not a Neon billing meter or account-wide quota**.
Unrelated SQL clients, older deployment URLs still serving old code, direct diagnostic commands,
and manual/Git-triggered Vercel builds are outside the local ledger. Each new Vercel build is still
limited to one 8 MB catalog response. Retired deployments should not be used as public entry points.
Check the Neon console after rollout; do not claim the project can never exceed its allowance.
No paid plan or new Neon account credential is required.

## Commands and local state

- `pnpm showcase:update`: budgeted publication and deployment only if live content differs.
- `pnpm showcase:update --deploy-code`: same checks, plus a deployment for code-only changes.
- `pnpm showcase:publish`: budgeted Neon/JSON publication only; does not update Vercel.
- `pnpm showcase:publication:register`: register or update only the Showcase task.

State is outside Git at `%LOCALAPPDATA%\Showcase\publication`:

- `transfer-budget.json`: durable reservations. Include in private backups. Missing/corrupt files
  stop updates. Do not delete it to bypass a limit.
- `update.lock`: overlap protection, PID and start time only. If a process was forcibly killed,
  verify that PID is no longer the publication process before removing this one stale lock.
- `latest.json` and `history.jsonl`: safe outcomes, counts, public content hash, and timestamps.

`--initialize-budget` is a one-time October 2026 bootstrap, refuses to overwrite existing state,
and is not a budget-reset command. Monthly accounting rolls forward automatically while retaining
rolling-week history. If other clients consume substantial transfer, raise the ledger's current
month baseline conservatively after reviewing the console, or pause this Showcase task.

The publisher reads the production scanner's existing local environment without modifying it.
Neon owner credentials are not used. Publisher and public-reader credentials remain in separate
existing local env files. Only the read-only Neon credential belongs in Vercel. The deployment
subprocess receives a minimal OS environment, and `.vercelignore` excludes local credentials,
private runtime files, build caches, test artifacts, and backups.

The pinned local Vercel CLI is installed under `.app-runtime/deployer` and requires a valid local
Vercel login. If login expires, reauthenticate interactively; scheduled runs fail safely and retry
only in the next allowed slot. No login token is written to the repository.

## Recovery and verification

Confirm the production `/api/catalog-status` hash matches `latest.json`. If publication succeeded
but deployment failed, the next allowed update can deploy that already-published catalog. Failed
updates do not erase the last working site. Vercel rollback can restore a previous deployment,
but only use snapshot-based deployments after this milestone to retain the zero-runtime-read design.
The local generated JSON remains available for development without Neon.

Neither this job nor its ledger repairs scanner matching backlogs or verifies playlist writes.
Those remain separate scanner operations and must not be inferred successful from a website update.
