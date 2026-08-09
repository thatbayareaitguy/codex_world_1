# AI Handoff

Updated: 2026-08-09 02:35 PDT

## Repository

- Branch: `codex/release-radar-hardening`
- Starting checkpoint: `8fc3d01e7b7d7cf363953a16425d5e358975a547`
- Current implementation checkpoint: this commit (`feat: support public authorized Spotify playlist`)
- Upstream before push: one local checkpoint ahead of `origin/codex/release-radar-hardening`
- Worktree: clean except unrelated untracked `outputs/`, which remains excluded
- PostgreSQL: healthy with all 29 forward migrations applied; this milestone adds no migration

## Current Milestone

Make the sole authorized Spotify release-inbox playlist public and shareable while preserving its
fixed ID, ownership, non-collaborative state, contents, Custom Order, export ledger, and default-off
write protections.

## Verified

- Live Spotify readback reports the authorized playlist is already public, owned by the connected
  account, non-collaborative, and contains 935 items. No visibility mutation was required.
- Full before-state inspection reports zero Custom Order moves. The verified item snapshot reconciled
  successfully with the persisted cache.
- A live guarded exporter dry run accepts the public playlist and used the reconciled snapshot cache.
  It found 24 pending eligible additions, 934 managed items already present, one unrelated user-added
  item, zero existing duplicates, and zero required reorder moves. No pending track was exported.
- Core safety now requires the exact authorized ID, authenticated ownership, and
  `collaborative=false`. Public and private states pass the reusable guard; production expects public.
- A dedicated fixed-target visibility command can only set the authorized playlist to
  `public=true` and `collaborative=false`. It cannot accept a browser-supplied or CLI-supplied target.
- Visibility verification checks ID, owner, name, description, artwork, item count, track multiset,
  exact order, `added_at`, `added_by`, and Custom Order before accepting success. An already-public
  playlist is idempotent and performs no mutation.
- Manual and scheduled exporters use the same updated guard. Existing add-only, no-remove,
  no-replace, no-reorder-except-Custom-Order, cooldown, request-gate, scope, ledger, and restart
  protections remain in place.
- Browser smoke renders `http://127.0.0.1:3000/#exports` as “Spotify public release inbox” with no
  console error or application error overlay.

## Validation

- Format, lint, strict TypeScript, production build, doctor, migration, and diff checks pass.
- Unit tests: 459 passed across 62 files.
- PostgreSQL integration tests: 140 passed across 27 files; the test database rebuilt through all 29
  migrations.
- Playwright: 30 passed.
- Doctor: READY, no Spotify cooldown, no stale lease, both playlist modification scopes granted, and
  the public/non-collaborative authorized-playlist policy ready.

## Partially Verified

- Thursday, Friday, and Saturday-Wednesday scheduled exports route through the tested shared exporter,
  but a complete recurring production week has not yet run unattended against the public playlist.

## Operational State

- Authorized playlist: public, owner verified, non-collaborative, 935 items.
- Spotify cooldown: none. No playlist operation lease remains.
- Playlist cache: reconciled with the live authorized-playlist snapshot.
- Pending export: 24 eligible additions remain intentionally untouched.
- Local app: responding at `http://127.0.0.1:3000/#exports`.

## Risks

- Spotify rate limits remain unpublished; all requests must continue through the shared PostgreSQL
  request gate and persisted cooldown.
- Public visibility makes the playlist shareable, but Spotify may expose its contents and owner-facing
  profile association according to Spotify product behavior.
- Recurring public-playlist export is covered by shared code and automated tests, not yet by a full
  unattended production week.

## Immediate Next Step

When the user approves exporting the 24 pending additions, run:

`pnpm spotify:playlist-export -- --live`

The normal production scheduler may perform the same guarded export without this manual command.

## Deferred

- Exporting the 24 pending tracks
- Provider discovery, scheduler cadence, Artist Albums budget, or Spotify pacing changes
- Deep historical reconciliation and inactive providers
