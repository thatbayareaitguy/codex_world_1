# AI Handoff

Updated: 2026-08-06 17:38 PDT (UTC-07:00)

Canonical implementation and operational snapshot. Credentials, tokens, private keys, personal
provider data, authorization headers, and raw provider payloads are excluded.

## Repository State

- Branch: `codex/release-radar-hardening`, tracking the matching GitHub branch.
- Starting commit for this milestone: `ef15ff2ff66275837b85bc9f74eadcebc0fe0884`.
- Current milestone commit: the commit containing this document.
- Worktree contains only the Apple identity ranking milestone until that commit is created and
  pushed. Ignored `.env`, runtime logs, and test artifacts are excluded.
- Milestone: Apple-family catalog enrichment, independent exact-link resolution, calibrated
  Apple-only ranking, and grouped review improvements.

## Architecture And Database

- TypeScript pnpm monorepo: Next.js web/API, Node scanner CLIs, provider-neutral core,
  Drizzle/PostgreSQL, Zod, Vitest, and Playwright.
- PostgreSQL remains authoritative for canonical records, provider identities, review decisions,
  catalog snapshots, rankings, request gates, cooldowns, OAuth data, and export ledgers.
- Twenty-two forward migrations are applied. Migration 0021 adds
  `apple_identity_candidate_catalogs` and `apple_identity_candidate_rankings`.
- Current Apple identity state: 349 confirmed mappings, consisting of 320 automatic and 29 manual;
  244 artists remain unresolved with 1,208 pending candidates.
- Persisted Apple ranking state: 150 catalog snapshots and 505 ranking rows across 100 unresolved
  artists.

## Verified

- The historical iTunes seed artifact has canonical SHA-256
  `0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660` but is not sanctioned as
  production identity evidence because its title-overlap ground truth came from Spotify. It is
  retained only as untrusted candidate inventory and never contributes to scores or confirmation.
- Candidate enrichment uses numeric Apple artist IDs only. The live fallback queried Apple's iTunes
  lookup API without names, Spotify IDs, Spotify URLs, ISRCs, UPCs, or Spotify catalog metadata.
- MusicBrainz direct Apple URLs and MusicBrainz-linked Wikidata P2850 values are treated as exact
  independent evidence only after validating the Apple resource. Multiple exact IDs and already
  claimed IDs remain conflicts instead of being forced.
- Apple-only activity, genre, label, release, and confirmed Apple co-credit signals rank candidates
  but cannot automatically confirm them. Soft scores are capped below the exact-evidence threshold.
- Rejection is reversible. Split-profile confirmation requires at least two validated Apple IDs.
- The grouped review UI displays rank, advisory score, artwork, Apple URL, genres, labels, activity,
  collaborators, releases, explanations, and Confirm, Reject/Restore, Split Profile, Not on Apple,
  and Defer actions. Spotify identity evidence is excluded from the Apple review payload.
- Fresh production-build browser QA against PostgreSQL verified enriched and unenriched candidate
  states, accessible actions, reversible rejected candidates, and MusicBrainz-only confirmed
  evidence.

## Live Validation

- Bounded pass: 100 unresolved artists, 150 Apple-family requests, 150 catalogs fetched, zero
  request failures, zero cooldown, and zero Spotify requests.
- Calibration truth set: 25 reconstructable groups and 97 unique candidates. Top-1 accuracy was
  25/25 and top-3 accuracy was 25/25. False confirmations and true-candidate eliminations were both
  zero. This is a small calibration sample, not universal proof.
- Exact-link results: zero unique direct MusicBrainz confirmations, zero Wikidata confirmations, one
  exact-link split-profile conflict, and one Wikidata request.
- Automatic results: zero title-overlap resolutions, zero collaboration-only resolutions, zero
  candidate eliminations, and zero automatic confirmations. The pass reduced review effort through
  ranking and enrichment, not by weakening confirmation safety.
- Three additional user decisions were saved after the pass, moving the live database from 346 to
  349 confirmed mappings and from 247 to 244 unresolved artists.

## Automated Validation

- Formatting: passed.
- Lint: passed with zero warnings.
- Strict TypeScript: passed across six workspaces.
- Unit tests: 388 passed in 52 files.
- PostgreSQL integration tests: 102 passed in 20 files, including a clean 22-migration test database.
- Production build: passed with 27 generated routes/pages.
- Playwright: 29 passed.
- `pnpm db:migrate`: passed and idempotent with 22 applied migrations.
- `pnpm doctor`: READY; no stale operation lock and no provider cooldown.
- `git diff --check`: passed.

## Implemented But Not Live-Verified

- Rich Apple Music API artist-view enrichment is implemented and mock-tested. Live validation used
  numeric iTunes lookup because Apple developer-token configuration is disabled locally.
- Unique direct MusicBrainz/Wikidata automatic confirmation is unit and integration tested, but the
  live sample produced no unique exact winner.

## Provider, Security, And Policy State

- Spotify remains connected but was not called. No Spotify mapping or playlist was read or changed.
- Spotify-derived data is excluded from Apple external requests, identity scores, persisted ranking
  evidence, and the Apple review API response.
- Apple Music developer-token configuration is disabled. No Apple cooldown or request lease exists.
- MusicBrainz is configured. Reddit remains approval-gated. SoundCloud automation remains excluded.

## Known Risks

- 244 Apple identities remain unresolved. Most have only ambiguous Apple-family catalog evidence.
- Only 10 unresolved review groups currently have both persisted catalog enrichment and rankings;
  the bounded request budget was intentionally consumed first by calibration and exact-link safety.
- Apple/iTunes search agreement is not independent identity proof because both are Apple catalogs.
- Split-profile conflicts are preserved for review but multi-profile scanning remains unsupported.

## Immediate Next Step

Review the ranked Apple candidates already persisted, then configure Apple developer-token settings
for a bounded live canary of the richer Apple Music relationship views. After that evidence is
validated, enrich the remaining unresolved candidates in additional bounded passes. Any proposal to
auto-confirm from Apple-only soft signals requires a separate policy decision and a larger zero-false
calibration sample.

## Deferred

- Soft-signal-only automatic confirmation, split-profile scanning, Music User Tokens, Apple personal
  library access, Spotify-derived Apple matching, scheduler activation, additional providers, mixed
  playback, and playlist reordering.
