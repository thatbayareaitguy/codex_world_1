# TS New Music Radar

TS New Music Radar is a private, single-user Release Inbox for a provider-neutral artist watchlist. It discovers releases through Spotify, MusicBrainz, approved Reddit evidence, or deterministic mock fixtures; preserves source evidence; routes uncertain matches to review; and prepares exact or confirmed Spotify tracks for restricted export to one private playlist. It has no playback.

## Current Scope

- Spotify: followed-artist import, mapped release discovery, exact track availability, read-only configured-playlist inspection, and default-disabled add-only export.
- MusicBrainz: artist mapping, release and release-group discovery, and upcoming release dates.
- Reddit: configurable evidence sources and deterministic parsing, disabled until Reddit grants explicit API approval.
- MockProvider: credential-free local scanning and tests.
- SoundCloud: optional manual outbound links only, disabled by default. No API, OAuth, player, metadata request, or hosted playlist.
- Deferred: YouTube, Apple Music, TIDAL, and every other provider.

Required software: Node.js 22 or newer, pnpm 11.9, Docker Desktop with Compose v2, and Git. Spotify Development Mode additionally requires the owner's existing Spotify Premium subscription.

## Initial Installation

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile
pnpm app:up:dev
```

`app:up:dev` starts PostgreSQL, applies migrations, and starts Next.js on `http://127.0.0.1:3000`. It does not overwrite `.env` or expose the app beyond loopback. Use `pnpm app:down` to stop the application and database while preserving the Docker volume. For production-like local operation, run `pnpm app:up` after a successful build.

Generate `APP_ENCRYPTION_KEY` before connecting Spotify:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Run `pnpm doctor` after editing `.env`. It checks versions, database connectivity, migrations, encryption, provider configuration, failed scans, locks, directories, backups, and port status without printing secrets.

## First Use

1. Register a Spotify Development Mode app with `http://127.0.0.1:3000/api/auth/spotify/callback` exactly, then set the Spotify variables and `SPOTIFY_ENABLED=true`.
2. Open Settings, connect Spotify in the browser, inspect the setup checklist, and import followed artists through the preview.
3. Add artists that are not followed on Spotify from Followed artists.
4. Use the MusicBrainz mapping controls to confirm exact identities and leave ambiguous identities in review.
5. Run `pnpm scan -- --provider mock` for a credential-free check, then `pnpm scan` for configured providers.
6. Review Needs review items. Only exact or manually confirmed Spotify matches are eligible for export.
7. Playlist writes are initially disabled. For read-only use, leave both playlist environment values at their defaults. If add-only export is enabled later, create one private playlist directly in Spotify and configure its ID server-side. The application has no picker and cannot create or alter playlists.

## Daily Operation

```powershell
pnpm doctor
pnpm scan
pnpm scan:status
```

Useful diagnostics and recovery:

```powershell
pnpm scan -- --dry-run
pnpm scan -- --provider spotify
pnpm scan -- --provider musicbrainz
pnpm scan -- --provider reddit
pnpm scan -- --artist <internal-artist-id>
pnpm scan -- --full
pnpm scan:unlock-stale
```

Reddit commands enforce `REDDIT_ENABLED=true`, `REDDIT_ACCESS_APPROVED=true`, complete credentials, and a valid descriptive User-Agent. The flags are not proof of approval. See [daily use](docs/daily-use.md) and [troubleshooting](docs/troubleshooting.md).

## Scheduling

The application does not schedule itself. Use Windows Task Scheduler to run `powershell.exe` with `-NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\run-daily-scan.ps1"`. Set Start in to the repository, select a daily trigger, and choose an account with Docker access. No secret belongs in the task definition because the scanner loads the ignored `.env` file. Test with Run and inspect `%LOCALAPPDATA%\TSNewMusicRadar\logs`.

Cron equivalent:

```cron
17 6 * * * cd /path/to/ts-new-music-radar && /usr/local/bin/pnpm scan >> "$HOME/.local/share/TSNewMusicRadar/logs/daily-scan.log" 2>&1
```

## Backup And Restore

```powershell
pnpm db:backup
pnpm db:restore -- --file "C:\path\to\ts-new-music-radar-<timestamp>.dump" --confirm-replace-data
pnpm db:migrate
pnpm doctor
```

Backups use `pg_dump -Fc`, are timestamped, refuse overwrite, and default outside the repository under `%LOCALAPPDATA%\TSNewMusicRadar\backups`. Restore uses `pg_restore --clean --if-exists --no-owner --exit-on-error` and requires explicit replacement confirmation. Restore with a PostgreSQL major version compatible with the source server, then verify artists, releases, feed, mappings, settings, and encrypted OAuth columns. Retention is manual; for example, review backups quarterly and explicitly remove superseded files only after testing a recent restore.

## Account And Data Removal

Disconnect Spotify in Settings to delete encrypted access and refresh tokens plus personal import records while preserving canonical artists. Delete all application data requires a separate confirmation and clears local records. It does not remove items already hosted by Spotify.

## Updating Safely

1. Run `pnpm db:backup`.
2. Pull or apply the new code.
3. Run `pnpm install --frozen-lockfile`, `pnpm db:migrate`, and `pnpm doctor`.
4. Run the verification commands below before resuming scheduled scans.

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
pnpm test:e2e
```

The optional real Spotify read test is `pnpm test:spotify:live -- --dry-run`. OAuth must already have been completed interactively. The command is strictly read-only and has no playlist-write mode.

Future SoundCloud Artist Pro work remains outside this milestone. It must pass the no-paid-developer-access and Spotify-policy review before any API implementation.
