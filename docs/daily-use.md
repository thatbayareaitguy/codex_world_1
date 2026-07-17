# Daily Use

1. Start local services with `pnpm app:up` or leave PostgreSQL and the built web app running under the local account.
2. Open `http://127.0.0.1:3000/#status` and confirm the database is current and no stale lock is present.
3. Run `pnpm scan`. The global lock prevents overlapping normal or provider scans.
4. Check `pnpm scan:status` after a partial failure. Retry only the failed provider with `pnpm scan -- --provider <name>`.
5. Review Needs review before exporting. Do not export fuzzy or unconfirmed matches.
6. Preview the Spotify playlist change and synchronize. Repeating it is idempotent.
7. Back up regularly with `pnpm db:backup` and test a restore after material upgrades.

The application does not run an internal scheduler. Windows Task Scheduler or cron must invoke the scan. Reddit remains inactive unless explicit approved access is configured.
