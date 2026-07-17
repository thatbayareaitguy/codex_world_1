# Troubleshooting

Run `pnpm doctor` first. It reports secret-safe remediation and exits nonzero when a required dependency is broken.

| Problem                       | Action                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Database unavailable          | Start Docker Desktop, run `pnpm db:up`, and verify `DATABASE_URL`.                                                                    |
| Migration failure             | Back up first, inspect `docker compose logs db`, then run `pnpm db:migrate`. Never edit applied migration history.                    |
| Spotify credentials missing   | Set the client ID and secret only in `.env`; keep Spotify disabled until both exist.                                                  |
| Spotify redirect URI mismatch | Register and set `http://127.0.0.1:3000/api/auth/spotify/callback`; do not use localhost.                                             |
| Spotify OAuth state error     | Restart connection from Settings. State expires after ten minutes and can be consumed once.                                           |
| Spotify reconnect required    | Use Reconnect Spotify in Settings; do not manually edit encrypted token columns.                                                      |
| Spotify rate limit            | Respect `Retry-After`; wait and rerun the provider scan.                                                                              |
| MusicBrainz throttling        | Confirm the contact email and allow the built-in one-request-per-second gate to finish.                                               |
| Reddit approval missing       | Keep Reddit disabled. No fallback, scraping, or unauthenticated request is permitted.                                                 |
| Reddit credentials invalid    | Confirm the approved app credentials and descriptive User-Agent without printing them.                                                |
| Scan already running          | Inspect `pnpm scan:status`. Do not clear a live lock.                                                                                 |
| Stale scan lock               | Confirm no scanner process exists, then run `pnpm scan:unlock-stale`. Only expired locks are removed.                                 |
| Playlist inaccessible         | Reconnect Spotify, confirm playlist ownership, and select another owned private playlist if needed.                                   |
| No releases found             | Check confirmed provider mappings, scan date window, cursors, and provider status. Try `--full` only as an explicit reconciliation.   |
| Unexpected duplicate          | Compare provider IDs, ISRC, version marker, credits, and duration. Preserve remix, live, edit, demo, and remaster distinctions.       |
| Ambiguous artist mapping      | Leave it in review until a canonical identity is manually confirmed.                                                                  |
| Scheduled task did not run    | Check Task Scheduler history, Docker access for the selected account, Start in, script execution policy, and the local log directory. |
| Backup failure                | Confirm Docker and the database are running and the backup directory is writable. Existing filenames are never overwritten.           |
| Restore failure               | Use an existing `.dump`, confirm compatible PostgreSQL versions, add `--confirm-replace-data`, then inspect Docker database logs.     |
