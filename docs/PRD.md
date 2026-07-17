# Product Requirements

## Objective

TS New Music Radar is a private, single-user, non-commercial release tracker. It maintains a provider-neutral watchlist, scans Spotify and MusicBrainz, can parse approved Reddit evidence when explicitly enabled, preserves evidence, and presents one chronological feed. MockProvider supports local development and automated tests.

The product optimizes for recall but never guarantees completeness. It has no audio playback, previews, players, embeds, public signup, advertising, or mixed-service queue.

## Active Scope

- Connect one Spotify account using server-side OAuth.
- Preview and explicitly confirm followed-artist imports into canonical records.
- Preserve manually entered artists and aliases.
- Store confirmed Spotify IDs and MusicBrainz MBIDs separately.
- Discover primary releases, album tracks, featured appearances, compilations, and future MusicBrainz dates.
- Match by same-provider ID, ISRC, MusicBrainz IDs, then strict metadata.
- Keep Reddit disabled until explicit Data API approval exists; exact canonical artist and title corroboration may attach evidence, while every other Reddit candidate enters review.
- Send ambiguous artist, recording, and version matches to review.
- Create and idempotently synchronize one owned private Spotify playlist.
- Keep saved, dismissed, listened, upcoming, new, and review feed states.

## Deferred Scope

YouTube, SoundCloud API and OAuth, SoundCloud playlists, Apple Music, TIDAL, playback, notifications, multi-user accounts, and commercial deployment are deferred. Existing manual SoundCloud URL records remain available only when `SOUNDCLOUD_MANUAL_LINKS_ENABLED=true`; the default is false and no SoundCloud request is made.

## Acceptance Boundary

The app starts without provider credentials and uses MockProvider. Real provider data stays namespaced with evidence. Scan and playlist operations are idempotent. Tokens are encrypted and server-only. Database tests run against provisioned PostgreSQL and never silently skip. All standard provider tests use synthetic responses.
