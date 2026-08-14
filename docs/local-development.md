# Local Development

## Requirements And Setup

Install Node.js 22+, pnpm 11.9, and Docker Desktop with Compose v2. Mock mode needs no provider credentials.

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm app:up:dev
```

`app:up:dev` starts PostgreSQL, applies all pending migrations, and serves only on `127.0.0.1:3000`. `pnpm app:up` uses a production build, creating it if needed. `pnpm app:down` stops the web process tree and database service but preserves the volume. Neither command modifies `.env`.

On Windows, register the production web application to start automatically after the current user
logs on:

```powershell
pnpm app:startup:register
Start-ScheduledTask -TaskName "TS New Music Radar Web Application"
```

Registration is safe to repeat. The hidden, non-overlapping task runs
`conhost.exe --headless node.exe --import tsx` directly, waits up to ten minutes per task attempt for
Docker Desktop and PostgreSQL, applies pending migrations, and then starts production Next.js only
on `127.0.0.1:3000`. Its persistent supervisor does not duplicate an already healthy server, removes
dead PID records, and restarts the web process after an exit or repeated health-check failure. Task
Scheduler retries a failed supervisor attempt three times at one-minute intervals. Remove the task
and its exact repository-scoped supervisor process without changing application data or `.env` with:

```powershell
pnpm app:startup:remove
```

Run components separately when debugging:

```powershell
pnpm db:up
pnpm db:migrate
pnpm dev -- --hostname 127.0.0.1 --port 3000
```

## Environment

Generate a base64-encoded 32-byte `APP_ENCRYPTION_KEY`. Set `MUSICBRAINZ_CONTACT_EMAIL` to a monitored address. Register the exact Spotify callback `http://127.0.0.1:3000/api/auth/spotify/callback`. Optional providers can be disabled independently.

Apple Music public-catalog discovery requires an active Apple Developer Program team, a MusicKit-enabled Media ID, and a Media Services private key. Configure `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID`, `APPLE_MUSIC_PRIVATE_KEY_PATH`, and a two-letter `APPLE_MUSIC_STOREFRONT`, then set `APPLE_MUSIC_ENABLED=true`. Keep the `.p8` key outside the repository. Do not configure or request a Music User Token.

Spotify playlist writes are off by default. Leave `SPOTIFY_PLAYLIST_WRITES_ENABLED=false` and `SPOTIFY_ALLOWED_PLAYLIST_ID=` for read-only authorization. For an explicitly approved add-only export, manually create an owner-controlled, non-collaborative playlist in Spotify, configure its 22-character ID, enable writes, and reconnect Spotify with forced consent to grant both `playlist-modify-private` and `playlist-modify-public`. Public and private visibility pass the guard; the authorized production target is expected to be public. The browser and CLI cannot select or override the configured ID.

Reddit must stay disabled until explicit Data API approval exists. `REDDIT_ACCESS_APPROVED=true` records the owner's assertion only and is not evidence of approval. Manual SoundCloud links can be enabled with `SOUNDCLOUD_MANUAL_LINKS_ENABLED=true`; this causes no SoundCloud request.

Use `DAILY_SCAN_TIME=HH:mm` only to display an expected next time in status. It does not create a schedule.

## Scanner And Diagnostics

```powershell
pnpm doctor
pnpm scan -- --provider mock
pnpm scan -- --provider spotify
pnpm scan -- --provider spotify --artist <internal-artist-id> --dry-run --spotify-max-pages 1
pnpm scan -- --provider spotify --spotify-mode daily
pnpm scan -- --provider spotify --spotify-mode reconciliation --confirm-spotify-batch
pnpm scan -- --provider apple_music
pnpm scan -- --provider apple_music --artist <internal-artist-id>
pnpm scan -- --provider reddit
pnpm scan -- --artist <internal-artist-id>
pnpm scan -- --dry-run
pnpm scan -- --full
pnpm scan:status
pnpm scan:unlock-stale
pnpm spotify:backfill-artwork --dry-run --limit 5
pnpm spotify:backfill-artwork --apply --limit 5
pnpm spotify:reconcile-releases -- --release <canonical-release-id> --page-size 10 --max-pages-per-release 1 --confirm-live
pnpm spotify:playlist-export -- --dry-run
pnpm spotify:playlist-export -- --live --max-additions 3
pnpm spotify:playlist-export -- --live
pnpm spotify:playlist-order -- --dry-run
pnpm spotify:playlist-order -- --canary
pnpm spotify:playlist-order -- --live
```

### Normal Apple-first discovery

The normal cross-provider workflow is `pnpm sync:apple-first`. It runs Apple Music discovery first,
then checks a bounded Spotify cohort by confirmed Spotify artist ID, reconciles only the separately
persisted provider records, and produces a read-only preview of the configured Spotify playlist.
It does not use Spotify Browse New Releases and cannot write to a playlist.

```powershell
pnpm sync:apple-first -- status
pnpm sync:apple-first -- run --confirm-live-providers --max-cohorts 1
```

Repeat the run command to resume the durable campaign. See
[Apple-First Discovery And Spotify Reconciliation](apple-first-sync.md) for canary, full-campaign,
status, retry, and policy-boundary details.

### First-week bootstrap transition

Finalize a completed Apple-first campaign without repeating Apple discovery or falsely completing
unfinished Spotify artists:

```powershell
pnpm discovery:bootstrap transition --campaign <campaign-id>
pnpm discovery:bootstrap status
```

The transition is database-only and safe to repeat. While Spotify has a stored cooldown, it leaves
the schedule in `cooldown_wait` and makes no provider request. After the cooldown expires, use this
order:

```powershell
pnpm run doctor
pnpm spotify:playlist-export -- --live --campaign <campaign-id> --discovery-inbox
pnpm discovery:bootstrap activate --campaign <campaign-id>
```

The export remains bound to `SPOTIFY_ALLOWED_PLAYLIST_ID`. It adds only campaign-confirmed tracks and
maintains release-date Custom Order without changing playlist membership. Activation refuses to run
until the inbox export is complete and the provider cooldown is clear. Production ticks still
require the separately configured `SPOTIFY_SCHEDULER_ENABLED=true` capability; do not change `.env`
as part of credential-free verification.

The unified tick reconciles an expired persisted cooldown before routing Spotify work. A due Friday
Apple catch-up remains claimable during an active Spotify cooldown and queues its Spotify work
behind unresolved Thursday priority. If the week's full Apple scan itself completed after Friday at
9:00 AM Pacific, that full result satisfies the catch-up and the scheduler does not repeat Apple
discovery.

### Bulk Apple Music identity resolution

Export the next prioritized unresolved batch outside the repository:

```powershell
pnpm apple-music:identities export --limit 100
```

Fill `decision`, `apple_music_url_or_id`, and optionally `user_note`. Supported decisions are
`confirm`, `unavailable`, `split_profile`, and `defer`. Separate multiple IDs for a split profile
with semicolons. The file intentionally contains no Spotify IDs, URLs, tracks, ISRCs, UPCs, or
other Spotify-derived evidence.

Preview and apply a completed file only when Apple developer-token credentials are configured:

```powershell
pnpm apple-music:identities preview --file "C:\path\completed.csv" --confirm-live
pnpm apple-music:identities apply --file "C:\path\completed.csv" --confirm-live
pnpm apple-music:identities verify
```

Preview and apply verify each exact user-supplied ID directly with Apple Music. Unsafe URLs,
missing artists, duplicate assignments, and mapping conflicts block the entire apply. Name
disagreements are reported as warnings and never cause candidate substitution. Apply repeats the
preview and persists the complete file in one transaction.

The preserved `musicbrainz-pass` command is not part of normal development or production use. It
fails closed while `MUSICBRAINZ_ENABLED=false`. Re-enable it only as a separately reviewed advanced
operation with a configured contact email, then repeat provider, integration, and live validation.

Run the calibrated Apple-family candidate enrichment and exact-link pass with:

```powershell
pnpm doctor
pnpm apple-music:identities resolve-pass --confirm-live --limit 100 --max-requests 150 --min-request-interval-ms 3200
```

`resolve-pass` accepts only retained numeric Apple candidate IDs. The dormant MusicBrainz input is
omitted while its provider flag is false. It never submits Spotify-derived query terms or metadata. When Apple Music
developer-token configuration is available, it reads artist relationship views. Otherwise it uses
Apple's numeric-ID iTunes lookup endpoint. Catalogs and rankings are persisted and reused. Soft
Apple-only signals rank review candidates but never confirm them automatically. See
[Apple Artist Identity Ranking](apple-identity-ranking.md) for the evidence and calibration rules.

Normal scans use one global database lock. Each provider records an independent run and failure, and a provider failure does not stop the remaining providers. Detailed errors and provider metrics expire after `SCAN_DETAIL_RETENTION_DAYS`; aggregate counts and timestamps remain.

Spotify uses one database-backed queue across web and scanner processes. The default and minimum configured interval is ten seconds with concurrency one. A provider 429 persists a client-wide cooldown across restart; do not clear or bypass a valid integer-second wait. Initial scans are limited to 15 artists per batch and begin paused for confirmation. See [Spotify Development Mode Scanning](spotify-development-mode-scanning.md).

Spotify playlist export always targets `SPOTIFY_ALLOWED_PLAYLIST_ID`. Dry-run reads the owned, non-collaborative playlist and reports additions, existing tracks, skip reasons, duplicate IDs, managed versus unmanaged membership, and Custom Order moves without mutation. Live mode requires `SPOTIFY_PLAYLIST_WRITES_ENABLED=true` and both stored playlist modification scopes. It records a durable run and per-track operation ledger, adds only exact or manually confirmed tracks, and maintains newest-release-first Custom Order with contiguous release groups. Existing and user-added tracks may move through snapshot-aware range operations, but they are never removed or re-added and their Spotify Date Added and Added By values remain intact. `--max-additions` is a canary limit, not a different target. An unchanged snapshot uses the verified cache; an external or interrupted-write snapshot change triggers one full reconciliation read. Successful internal writes update the cache from returned snapshot IDs and do not force repeated pagination. No export command creates, removes, replaces, renames, follows, or changes playlist visibility.

The verified steady-state read cost is one account check and one playlist metadata/snapshot check per
export attempt when the snapshot is unchanged. A changed snapshot requires one complete item read;
with Spotify's 50-item page limit, the current 1,009-item playlist requires 21 item pages plus the
before/after metadata checks. Reorder ranges are capped at 100 items and resume from the last persisted
snapshot after interruption.

The production playlist visibility is managed by one fixed-target command. It has no playlist-ID argument and cannot select another playlist:

```powershell
pnpm spotify:playlist-visibility -- --dry-run
pnpm spotify:playlist-visibility -- --live
```

Dry-run verifies the owner, collaboration state, item count, and Custom Order without mutation. Live mode sets only `public=true` and `collaborative=false`, then verifies item membership, exact order, `added_at`, `added_by`, owner, name, description, artwork, and the persisted snapshot cache. It does not export pending tracks.

The initial 935-item Custom Order validation used 84 playlist-read requests across its dry run,
canary readback, interrupted conversion recovery, and final verification. It completed 473 range
moves without a 429 and preserved every item's `added_at` and `added_by` metadata. After the verified
snapshot was cached, an unchanged-snapshot export preview used one playlist metadata read and zero
playlist-item page reads. External changes invalidate that steady-state cost and require one complete
reconciliation read before writes continue.

Apple Music uses a separate database-backed queue with concurrency one and a minimum 1100 ms request-start interval. Normal scans load only confirmed Apple mappings, use first-page `singles` and `full-albums` views, fetch tracks only for eligible recent releases, and persist after every artist. A never-scanned artist uses at most a 30-day lookback; later scans begin at the last successful timestamp within that floor. Missing optional views and invalid release records are isolated. Resume with the same normal command after a budget, runtime, transient, or cooldown stop.

The artwork backfill reads only stored Spotify album IDs and calls the official album endpoint. It defaults to dry-run, requires an explicit limit from 1 through 25, and needs `--apply` before it writes provider metadata. Apply mode saves a provider cursor after every completed release; add `--resume` to continue after that cursor. The command never searches Spotify, inspects playlists, or changes canonical release and track identity.

Release-only reconciliation requires 1 through 25 explicit canonical release IDs and `--confirm-live`. It calls only the Spotify album-tracks endpoint, uses the shared request gate and request budget, verifies every returned track against the existing canonical release appearance, and persists each page before continuing. `--page-size` accepts the provider-supported range 1 through 50 and defaults to 50; use a smaller value only for an explicitly bounded validation. Completed releases are skipped without a provider request.

## Tests

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
git diff --check
```

`test:integration` starts `db-test` on port 5433, recreates the public schema, and applies every migration. It fails instead of skipping when Docker is unavailable.

The optional real test is separate:

```powershell
pnpm test:spotify:live -- --dry-run
```

The command requires completed browser OAuth and is read-only. It has no playlist-write mode.

## Scheduling And Logs

`scripts/run-daily-scan.ps1` remains a manual logging wrapper. Do not use it as an interactive
scheduled-task action. Windows Task Scheduler actions must launch the intended TypeScript CLI through
`conhost.exe --headless node.exe --import tsx`, use the repository as the working directory, and put
no secrets in task arguments. The scanner loads ignored local configuration, uses its operation lock,
and writes structured logs under `%LOCALAPPDATA%\TSNewMusicRadar\logs`.

Temporary Spotify campaign tasks must be registered through
`scripts/register-spotify-campaign-task.ps1`. The registered action bypasses `powershell.exe` and
`pnpm.cmd`: Task Scheduler launches `conhost.exe --headless`, which runs `node.exe --import tsx`
against the campaign CLI. The task itself is marked hidden and rejects overlapping instances. Do not
replace that action with a PowerShell or pnpm task action, because either console host can briefly
take focus from a full-screen application on every tick.

The recurring scheduler combines weekly Apple jobs and the bounded Spotify worker. Its read-only
status command is:

```powershell
pnpm discovery:scheduler:status
```

The bounded scheduler entry point is `apps/scanner/src/discovery-scheduler-cli.ts tick`. It claims at
most one due Apple job or one bounded broad Spotify work unit and exits. During Apple-priority
resolution, one process may handle up to `SPOTIFY_PRIORITY_MAX_ITEMS_PER_RUN` committed priority work
items, default 10. It immediately claims the next priority item after the previous item commits; the
shared Spotify request gate supplies the required 10-second request spacing and rolling-capacity
check. Register the entry point through the same hidden
`conhost.exe --headless node.exe --import tsx` action pattern at a one-minute wake-up interval. The
Windows interval is not the artist pacing mechanism. The actual Thursday 9:00 PM Apple scan, Friday
9:00 AM catch-up, Saturday-Wednesday Spotify window,
recovery deadlines, daily ceilings, and provider cooldowns are enforced from PostgreSQL state in
`America/Los_Angeles`, not by the Windows trigger time.

`DISCOVERY_SCHEDULER_ENABLED` and `SPOTIFY_SCHEDULER_ENABLED` both default to `false`. The first
enables the unified tick and the second enables its Spotify executor. Keep both disabled during
credential-free verification and while an active Spotify cooldown is stored. The status command
never starts provider work.

Automatic Thursday and Friday playlist delivery also requires all existing playlist safeguards:

```dotenv
DISCOVERY_SCHEDULER_ENABLED=true
SPOTIFY_SCHEDULER_ENABLED=true
SPOTIFY_PLAYLIST_WRITES_ENABLED=true
SPOTIFY_ALLOWED_PLAYLIST_ID=4l6LaMPL6duulmFe3hRR4Y
SPOTIFY_ARTIST_ALBUMS_24H_LIMIT=80
SPOTIFY_ARTIST_ALBUMS_PRIORITY_RESERVE=20
SPOTIFY_ARTIST_ALBUMS_RESERVE_RELEASE_AFTER_HOURS=20
```

If recurring discovery is enabled while playlist writes are disabled, `pnpm doctor` reports an
action item because the durable playlist-inbox phase cannot advance. Enabling writes does not give
the scheduler permission to select, create, rename, remove from, replace, or change another
playlist. The server-configured allowed playlist remains the only valid target. Custom Order range
moves are allowed only on that target.

The unified recurring order is: drain any previously pending export, run the due Apple scan,
process its Apple-priority Spotify resolution, automatically export the newly eligible tracks, then
allow Saturday-Wednesday broad Spotify rotation. The final priority resolution and guarded export
can complete in the same tick; no manual export command or confirmation is part of normal production
operation. Friday catch-up follows the same priority-then-export sequence. Thursday and Friday never
run broad Spotify work. If the process exits or a provider cooldown interrupts export, the next tick
resumes the durable export phase before lower-priority work. The manual dry-run and live commands
remain available only for diagnostics and explicitly initiated maintenance.

During the Saturday-Wednesday window, broad work accumulates one durable playlist checkpoint rather
than exporting after every artist. The unified tick flushes that checkpoint in supported batches at
the rolling-request, daily artist/request, or Artist Albums boundary, or when the broad queue drains.
If a 429 interrupts broad work, the pending checkpoint waits through the stored cooldown and resumes
before broad scanning continues.

Cron example:

```cron
17 6 * * * cd /path/to/repo && /usr/local/bin/pnpm scan >> "$HOME/.local/share/TSNewMusicRadar/logs/daily-scan.log" 2>&1
```

## Backup And Restore

`pnpm db:backup` creates a timestamped PostgreSQL custom-format dump outside the repository. Restore requires `pnpm db:restore -- --file <path> --confirm-replace-data`, followed by migrations and doctor. Use compatible PostgreSQL major versions and verify watchlist, releases, feed, mappings, settings, and encrypted OAuth columns after restore.

Disaster-recovery verification procedure:

1. Use a test database and insert synthetic artists, releases, feed items, mappings, settings, and an encrypted fake OAuth token.
2. Run `pnpm db:backup` against that database and record the dump path.
3. Reset only the test database.
4. Restore the dump with explicit confirmation, then run migrations.
5. Compare record counts and stable synthetic IDs for artists, releases, feed, mappings, and settings.
6. Confirm OAuth ciphertext remains ciphertext and cannot be found as fixture plaintext.
7. Run `pnpm doctor` and the integration suite.

Never use real provider data in automated recovery fixtures. Backup retention is manual by default; no command deletes backups automatically.
