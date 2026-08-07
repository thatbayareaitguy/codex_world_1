# AI Handoff

Updated: 2026-08-07 12:55 PDT

## Repository State

- Branch: `codex/release-radar-hardening`
- Latest commit: this handoff-only checkpoint on `codex/release-radar-hardening`; it directly follows
  pushed implementation checkpoint `8ff1845495342536db677d1587bcbb8b966f828d`
- Upstream: local and origin match after this handoff checkpoint
- Milestone: Apple-first discovery with independent Spotify reconciliation
- Worktree: clean except unrelated untracked `outputs/`; ignored `.env` remains local
- Database: PostgreSQL healthy; all 23 forward migrations applied idempotently
- Apple Team ID, Key ID, and protected private-key path are restored in ignored `.env`; values are
  not documented or staged

## Architecture

- `pnpm sync:apple-first` snapshots active artists with independently confirmed Apple and Spotify
  identities, runs Apple discovery first, then bounded Spotify Artist Albums cohorts, and reconciles
  only persisted provider-native observations inside PostgreSQL.
- Durable campaign, per-artist, and release-reconciliation rows preserve provider progress, retry
  state, request attribution, cross-provider outcomes, playlist eligibility, and coverage totals.
- Apple discoveries prioritize Spotify cohorts. A rotating fallback covers artists without recent
  Apple discoveries. Intermediate cohorts pause without rereading the playlist.
- Playlist export is dry-run only and targets the one configured Spotify playlist after the final
  cohort. MusicBrainz, Reddit, SoundCloud, and the Spotify scheduler remain disabled for this flow.

## Verified

- Five-artist canary `e4131c54-2f25-4913-a340-6da5966fe436` completed: 5 Apple and 5 Spotify
  artists, 10 Apple and 25 Spotify requests, 0 provider failures, 0 retries, and 0 rate limits.
- Canary reconciliation: 0 matched, 0 Apple-only, 3 Spotify-only, 0 uncertain, 0 missing Spotify
  track matches, and 2 playlist-eligible tracks.
- Re-running the completed canary by campaign ID made no provider request; counters remained 10 and 25. The status command now awaits its report before closing PostgreSQL, with integration coverage.
- Playlist dry run: 810 eligible and already present, 0 additions, 0 duplicate tracks, 0 release-date
  ordering conflicts, 3 historical group-contiguity conflicts, and 1 preserved unrelated user track.
  No playlist write occurred.
- Full campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94` snapshotted 583 active dual-provider
  identities. Apple completed all 583 with 1,314 requests and 0 failures or rate limits.
- Spotify persisted 95 artists before stopping correctly on a 429: 94 partial, 1 complete, 1
  rate-limited retry point, and 487 pending. Current partial reconciliation totals are 98 matched,
  16 Apple-only, 65 Spotify-only, 3 uncertain, 5 missing Spotify track matches, and 265
  playlist-eligible tracks. No operation lock or provider lease remains.
- A PostgreSQL/application clock-skew defect in completed album-page counting was corrected by
  persisting the page completion time as the track observation time. Interrupted retrievals now
  retain both their completed-track count and resume cursor.
- Browser smoke passed against the running database feed: the default New tab, provider evidence,
  persisted rate-limited batch history, and campaign progress load without browser console errors.

## Partially Verified Or Blocked

- The full campaign is paused in Spotify reconciliation after `429 QUOTA_EXCEEDED` on
  `artist_albums`. Raw and parsed `Retry-After` are 82,274 seconds.
- Spotify cooldown is active until `2026-08-08T18:32:23.020Z`, or 2026-08-08 11:32:23 PDT. Do not
  probe, clear, or bypass it.
- Final cross-provider coverage counts and final playlist preview are unavailable until the remaining
  488 Spotify artist states complete.

## Validation

- Current credential-free verification: formatting, lint, strict TypeScript in 6 workspaces, 406
  unit tests across 57 files, 110 PostgreSQL integration tests across 22 files, 29 Playwright tests,
  production build with 27 routes, all 23 migrations, browser smoke, and `git diff --check` passed.
- Doctor after the live stop: database, migrations, locks, Apple state, album completeness, and app
  are healthy; only the persisted Spotify cooldown requires action.

## Risks

- Spotify quota behavior remains unpublished. The full campaign must resume only after the stored
  cooldown and continue through the same global 10-second request gate.
- The three historical noncontiguous release groups cannot be repaired under the add-only playlist
  boundary without reordering existing tracks. They and the unrelated user track remain unchanged.
- Provider requests and evidence remain namespaced. No Apple metadata is sent to Spotify and no
  Spotify metadata is sent to Apple.

## Next Action

After 2026-08-08 11:32:23 PDT, run `pnpm doctor`. If the cooldown is expired and no lock exists,
resume only campaign `5f462e9e-c3db-451c-b77c-378ab21e8a94`:

```powershell
$env:APPLE_MUSIC_ENABLED='true'
$env:MUSICBRAINZ_ENABLED='false'
$env:REDDIT_ENABLED='false'
pnpm sync:apple-first -- run --confirm-live-providers --campaign 5f462e9e-c3db-451c-b77c-378ab21e8a94 --max-cohorts 10000
```

Then prove completed-campaign idempotency, run the full validation suite, update this handoff, commit,
and push. Do not create a new campaign.

## Deferred

- Any live Spotify playlist write or repair reorder
- MusicBrainz production reactivation
- Reddit activation, SoundCloud automation, and new providers
