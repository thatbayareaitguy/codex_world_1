# Daily Use

1. Start local services with `pnpm app:up` or leave PostgreSQL and the built web app running under the local account.
2. Open `http://127.0.0.1:3000/#status` and confirm the database is current and no stale lock is present.
3. Run `pnpm scan -- --provider spotify` for the bounded Spotify daily scan. Generic `pnpm scan` runs enabled configured providers. MusicBrainz is disabled by default and is not a daily-use provider. The global lock prevents overlap.
4. Check `pnpm scan:status` after a partial failure. Retry only the failed provider with `pnpm scan -- --provider <name>`.
5. Review Needs review before exporting. Do not export fuzzy or unconfirmed matches.
6. Leave playlist writes disabled for read-only operation. If the server-side add-only gate is later enabled, preview the configured allowlisted playlist change before synchronizing. Repeating an allowed addition is idempotent.
7. Back up regularly with `pnpm db:backup` and test a restore after material upgrades.

The application does not run an internal scheduler. Windows Task Scheduler or cron must invoke the scan. Reddit remains inactive unless explicit approved access is configured.

## Spotify Catalog Coverage

- `Daily scan current` means page one was checked recently. It does not mean every catalog page was checked.
- `Partial catalog` or `Reconciliation queued` means Spotify returned another page. The stored next offset is retained across process restarts.
- Deep reconciliation processes at most 15 artists and 2 pages per artist by default. It pauses at 150 requests per run and can be resumed.
- Start reconciliation only from the confirmed UI action or with `pnpm scan -- --provider spotify --spotify-mode reconciliation --confirm-spotify-batch`.
- Do not add `--spotify-new-reconciliation-cycle` when resuming. That flag intentionally resets selected artists to page one for a new cycle.
- Provider totals produce estimates, not exact completion times. Do not infer chronological ordering from a page.
