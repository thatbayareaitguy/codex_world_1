# Local Development

## Requirements And Setup

Install Node.js 22+, pnpm 11.9, and Docker Desktop with Compose v2. Mock mode needs no provider credentials.

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm app:up:dev
```

`app:up:dev` starts PostgreSQL, applies all pending migrations, and serves only on `127.0.0.1:3000`. `pnpm app:up` uses a production build, creating it if needed. `pnpm app:down` stops the web process tree and database service but preserves the volume. Neither command modifies `.env`.

Run components separately when debugging:

```powershell
pnpm db:up
pnpm db:migrate
pnpm dev -- --hostname 127.0.0.1 --port 3000
```

## Environment

Generate a base64-encoded 32-byte `APP_ENCRYPTION_KEY`. Set `MUSICBRAINZ_CONTACT_EMAIL` to a monitored address. Register the exact Spotify callback `http://127.0.0.1:3000/api/auth/spotify/callback`. Optional providers can be disabled independently.

Reddit must stay disabled until explicit Data API approval exists. `REDDIT_ACCESS_APPROVED=true` records the owner's assertion only and is not evidence of approval. Manual SoundCloud links can be enabled with `SOUNDCLOUD_MANUAL_LINKS_ENABLED=true`; this causes no SoundCloud request.

Use `DAILY_SCAN_TIME=HH:mm` only to display an expected next time in status. It does not create a schedule.

## Scanner And Diagnostics

```powershell
pnpm doctor
pnpm scan -- --provider mock
pnpm scan -- --provider spotify
pnpm scan -- --provider musicbrainz
pnpm scan -- --provider reddit
pnpm scan -- --artist <internal-artist-id>
pnpm scan -- --dry-run
pnpm scan -- --full
pnpm scan:status
pnpm scan:unlock-stale
```

Normal scans use one global database lock. Each provider records an independent run and failure, and a provider failure does not stop the remaining providers. Detailed errors and provider metrics expire after `SCAN_DETAIL_RETENTION_DAYS`; aggregate counts and timestamps remain.

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
pnpm test:spotify:live -- --playlist-write --confirm-temporary-playlist
```

The read-only command requires completed browser OAuth. Write mode creates only a clearly named temporary private playlist and never touches the configured Release Inbox playlist. The minimum scopes do not permit cleanup, so remove that temporary playlist manually in Spotify.

## Scheduling And Logs

Windows Task Scheduler should invoke `scripts/run-daily-scan.ps1`. The script changes to the repository, relies on the scanner's ignored `.env` loader, uses the scan lock, writes dated logs under `%LOCALAPPDATA%\TSNewMusicRadar\logs`, and returns the scanner exit code. Do not put secrets in task arguments. Configure Run whether user is logged on or not only when that account can start Docker Desktop, then use Task Scheduler's Run command to test it.

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
