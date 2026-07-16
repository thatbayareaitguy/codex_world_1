# Local Development

## Requirements

- Node.js 22 or newer
- pnpm 11
- Docker Desktop with Compose v2
- Spotify Premium only when using a Spotify Development Mode app

Mock mode requires no provider credentials and makes no live provider request.

## Setup

```powershell
Copy-Item .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm dev -- --hostname 127.0.0.1
```

Open `http://127.0.0.1:3000`.

Generate `APP_ENCRYPTION_KEY` as a base64-encoded 32-byte value. One PowerShell option is:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

Set `MUSICBRAINZ_CONTACT_EMAIL` to a monitored address. Set Spotify credentials only after registering the exact 127.0.0.1 callback. Either provider can be disabled independently. Manual SoundCloud development controls can be enabled with `SOUNDCLOUD_MANUAL_LINKS_ENABLED=true`; this adds no SoundCloud API behavior.

## Database Tests

```powershell
pnpm db:up
pnpm db:migrate
pnpm db:reset:test
pnpm test:integration
pnpm db:down
```

The integration command starts `db-test` on port 5433, recreates its public schema, applies every migration, and fails with an actionable Docker error instead of skipping.

## Scanner

```powershell
pnpm scan -- --provider mock
pnpm scan -- --provider spotify
pnpm scan -- --provider musicbrainz
pnpm scan -- --artist <internal-artist-id>
pnpm scan -- --dry-run
pnpm scan -- --full
pnpm scan -- --since 2026-06-01
```

Normal `pnpm scan` runs every configured real provider. If neither is configured, it uses MockProvider. The initial backfill defaults to 60 days. Use `--full` only for explicit reconciliation.

## Scheduling

Generic cron example:

```cron
17 6 * * * cd /srv/ts-radar && /usr/local/bin/pnpm scan
43 5 * * 0 cd /srv/ts-radar && /usr/local/bin/pnpm scan -- --full
```

For Windows Task Scheduler, create a daily task whose program is `pnpm.cmd`, arguments are `scan`, and Start in is the repository directory. Create a separate weekly task with arguments `scan -- --full`.

## Spotify Workflow

1. Start the web app on 127.0.0.1.
2. Open Settings and connect Spotify.
3. Select Import followed artists.
4. Review the preview and confirm selected create or merge actions.
5. Run the Spotify and MusicBrainz scans.
6. Open Playlist exports, create or select an owned private playlist, preview sync, then sync.
7. Disconnect from Settings to delete tokens and personal import history while preserving canonical watchlist records.
