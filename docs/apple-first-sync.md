# Apple-First Discovery And Spotify Reconciliation

## Purpose

`pnpm sync:apple-first` is the normal provider orchestration command. It treats Apple Music as the
broad recent-release source, then checks a bounded Spotify artist cohort and reconciles the two
independently persisted catalogs inside PostgreSQL. It ends with a read-only preview of the one
configured Spotify playlist. It never performs a playlist write.

The campaign snapshots the confirmed Apple Music and Spotify artist IDs for every active artist.
Apple requests contain only the Apple artist ID and Apple-native catalog parameters. Spotify
requests contain only the confirmed Spotify artist ID and Spotify-native catalog parameters. No
title, release, track, ISRC, UPC, or other metadata is transferred from one provider to the other.

## Commands

Inspect the latest campaign without calling a provider:

```powershell
pnpm sync:apple-first -- status
pnpm sync:apple-first -- status --campaign <campaign-id>
```

Run a representative five-artist campaign:

```powershell
pnpm sync:apple-first -- run --confirm-live-providers --artist-limit 5 --spotify-cohort-size 5 --spotify-rotation-size 2 --spotify-page-limit 1
```

Start or resume the full active-watchlist campaign and process one Spotify cohort:

```powershell
pnpm sync:apple-first -- run --confirm-live-providers --max-cohorts 1
```

Continue all currently eligible cohorts in one process:

```powershell
pnpm sync:apple-first -- run --confirm-live-providers --max-cohorts 10000
```

Use the one-cohort form for normal scheduling. Repeating it resumes the same campaign. Intermediate
cohort runs pause without reading the Spotify playlist. The read-only playlist preview runs once,
after the final eligible Spotify artist has been reconciled. Rerunning an already completed campaign
returns its persisted report without calling either provider. A process restart does not repeat
completed Apple artists or completed Spotify campaign artists. A provider budget, retry time, or
cooldown leaves the campaign paused; rerun the same command only after the reported eligibility time
or cooldown has passed.

`--spotify-cohort-size` controls the bounded Spotify work unit. `--spotify-rotation-size` reserves
part of each cohort for the oldest artists without a recent Apple discovery. The remainder
prioritizes artists with recent Apple discoveries. `--spotify-page-limit` bounds Spotify Artist
Albums pagination and defaults to the configured daily page limit. Spotify Browse New Releases is
not used.

## Persisted Results

The campaign stores per-artist Apple and Spotify progress, request counts, retry eligibility,
provider batch IDs, recent-Apple priority, and attempt counts. Release reconciliation stores:

- matched on Apple Music and Spotify
- Apple-only
- Spotify-only
- uncertain matches, including every comparable conflicting candidate
- matched releases with missing Spotify track matches
- playlist-eligible Spotify track counts

Provider request totals, transient retry attempts, HTTP 429 counts, and cooldown snapshots are
stored on the campaign. Reconciliation is deterministic and replace-idempotent for each campaign
artist. Material title, release-date, or release-type contradictions remain uncertain.

## Playlist Boundary

The final preview can read only `SPOTIFY_ALLOWED_PLAYLIST_ID`. Its Spotify client always has playlist
writes disabled, regardless of `SPOTIFY_PLAYLIST_WRITES_ENABLED`. It reports additions, skips,
duplicates, release ordering, release-group contiguity conflicts, and preserved unrelated items.
Use the separate `spotify:playlist-export -- --live` command only after a distinct explicit approval.

Do not enable MusicBrainz, Reddit, SoundCloud, or the rolling Spotify scheduler for this workflow.
