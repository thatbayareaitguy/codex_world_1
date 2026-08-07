# Product Requirements

## Objective

TS New Music Scanner is a private, single-user, non-commercial release tracker. It maintains a provider-neutral watchlist, scans Spotify and Apple Music, can parse approved Reddit evidence when explicitly enabled, preserves evidence, and presents one chronological feed. MockProvider supports local development and automated tests. The preserved MusicBrainz adapter is dormant and disabled by default.

The product optimizes for recall but never guarantees completeness. It has no audio playback, previews, players, embeds, public signup, advertising, or mixed-service queue.

## Active Scope

- Connect one Spotify account using server-side OAuth.
- Preview and explicitly confirm followed-artist imports into canonical records.
- Preserve manually entered artists and aliases.
- Store confirmed Spotify IDs and MusicBrainz MBIDs separately.
- Store confirmed Apple Music artist IDs separately and route uncertain or candidate-free mappings through the existing review queue.
- Discover recent Apple Music singles, EPs, and albums from shallow public-catalog views, then retrieve tracks only for releases inside the 30-day or last-success window.
- Display validated Apple Music artwork only for Apple-backed evidence and link it to the corresponding Apple Music release. Store URLs and dimensions only.
- Display validated Spotify album or single artwork for Spotify-backed discoveries, linked to the corresponding Spotify album. Store only provider URLs and dimensions; do not download, proxy, transform, or reuse the image for another provider.
- Discover primary releases, album tracks, featured appearances, compilations, and provider-supported future dates.
- Match by same-provider ID, ISRC, MusicBrainz IDs, then strict metadata.
- Keep Reddit disabled until explicit Data API approval exists; exact canonical artist and title corroboration may attach evidence, while every other Reddit candidate enters review.
- Send ambiguous artist, recording, and version matches to review.
- Prepare idempotent add-only synchronization to one owned private Spotify playlist. Writes remain disabled by default and require the server-configured allowlisted playlist ID.
- Keep saved, dismissed, listened, upcoming, new, and review feed states.

## Deferred Scope

YouTube, SoundCloud API and OAuth, SoundCloud playlists, TIDAL, Apple Music user-library access, Apple Music playback, Apple Music playlist mutation, notifications, multi-user accounts, and commercial deployment are deferred. Existing manual SoundCloud URL records remain available only when `SOUNDCLOUD_MANUAL_LINKS_ENABLED=true`; the default is false and no SoundCloud request is made.

## Acceptance Boundary

The app starts without provider credentials and uses MockProvider. Real provider data stays namespaced with evidence. Provider artwork is optional and never required for canonical matching; existing records without artwork retain a generic fallback. Scan and playlist operations are idempotent. Spotify and Apple Music scans are globally serialized per provider, cooldown-aware, bounded, persisted after each artist, and resumable without restarting completed work. Apple Music uses only a server-side developer token and public catalog endpoints. Completeness remains bounded by each provider's catalog, storefront, and regional availability. Tokens and private keys are server-only. Database tests run against provisioned PostgreSQL and never silently skip. All standard provider tests use synthetic responses.
