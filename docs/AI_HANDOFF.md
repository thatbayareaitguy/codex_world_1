# AI Handoff

Updated: 2026-08-06 21:25 PDT

## Repository State

- Branch: `codex/release-radar-hardening`
- Starting commit: `c509edf` (`docs: record completed Apple identity queue`)
- Milestone: MusicBrainz production disablement, verified and pending commit/push
- Upstream: `origin/codex/release-radar-hardening`; synchronized before this milestone
- Worktree: milestone files modified; unrelated untracked `outputs/` is excluded
- Database: PostgreSQL healthy with 22 migrations applied; no migration is required for this change

## Architecture

- Next.js web/API, separate Node scanner, PostgreSQL with Drizzle, provider packages, and shared
  PostgreSQL-backed provider request gates remain unchanged.
- Active normal providers are Spotify, Apple Music, and MockProvider. Reddit remains approval-gated.
- MusicBrainz code, schema, mappings, evidence, and scan history are preserved but dormant.
  `MUSICBRAINZ_ENABLED` now defaults to `false`.
- Scanner, Apple identity CLI, web scan launcher, mapping APIs, status APIs, review UI, artist UI,
  settings, and source status all enforce or reflect the MusicBrainz feature boundary.

## Verified Working

- Disabled explicit MusicBrainz scanner calls fail before database mutation or network access.
- Generic scans do not select MusicBrainz while disabled.
- Mapping routes return HTTP 403 while disabled; explicitly enabled advanced paths remain covered.
- Normal GUI omits MusicBrainz controls, reviews, settings, source state, system state, and history.
- Doctor reports disabled MusicBrainz as `OPTIONAL_PROVIDER_DISABLED` and remains `READY`.
- Existing canonical feed data is unchanged: 974 feed rows before and after the disabled command.
- Preserved MusicBrainz data is unchanged: 6 artist IDs, 20 mapping reviews, 4 evidence rows,
  11 scan runs, 8 scan batches, 13 artist scans, and 77 request events before and after.
- No live Spotify, Apple Music, MusicBrainz, Reddit, or SoundCloud request occurred in this milestone.

## Validation

- Format: passed
- Lint: passed
- TypeScript: passed in 6 workspaces
- Unit tests: 394 passed across 54 files
- PostgreSQL integration: 103 passed across 20 files; clean test database applied all 22 migrations
- Production build: passed with 27 routes/pages
- Playwright: 29 passed, including disabled MusicBrainz GUI, system status, and zero-request coverage
- Database migration: idempotent, 22 applied
- `git diff --check`: passed

## Risks And Decisions

- The ignored local `.env` currently explicitly opts in with `MUSICBRAINZ_ENABLED=true`. Repository
  rules prohibit modifying `.env`; the user must set it to `false` and restart local processes to
  apply the new default locally. Source-controlled defaults and production guidance are false.
- Re-enabling MusicBrainz is implemented but was not live-tested in this milestone. Treat it as an
  advanced, separate validation session, not a production capability.
- No historical MusicBrainz row was deleted, rewritten, or hidden from direct database inspection.
- Spotify cross-service policy uncertainty remains. Provider-specific data must stay namespaced.

## Next Action

1. Finish final credential-free verification, commit, and push this milestone.
2. Set the ignored local `MUSICBRAINZ_ENABLED=false`, restart the app, and confirm `pnpm doctor` is
   `READY` with `OPTIONAL_PROVIDER_DISABLED`.
3. Begin the planned Apple-first Spotify reconciliation review without using MusicBrainz.

## Deferred

- MusicBrainz advanced-mode live validation and any deletion of MusicBrainz code, schema, or data
- Apple-first Spotify reconciliation implementation
- Reddit activation, SoundCloud automation, and additional providers
