# AI Handoff

Updated: 2026-07-29

## Repository State

- Worktree: `C:\Users\taysh\Documents\Codex\codex_world_1_apple`
- Branch: `codex/apple-music-discovery`
- Starting branch point: `bfd305149ab6776bb84a0809009ff3ecc435d5ba`
- Upstream: `origin/codex/apple-music-discovery`
- Scope: policy-only authorization checkpoint

## Authorized Scope

Repository policy now permits a disabled-by-default, bounded Apple Music API public catalog pilot
on this branch only. The user approved Apple Developer Program access and developer-token
authentication for public catalog requests.

Credential-free tests must pass before any live Apple request. Each live request milestone must be
separately authorized and explicitly bounded.

## Prohibited Scope

- No Music User Tokens, personal-library access, playback, Apple playlists, or Apple Music Feed
- No production scheduling, production integration, or merge into
  `codex/release-radar-hardening`
- No Spotify, iTunes, SoundCloud, MusicBrainz, Reddit, or other provider activity
- No tracked or reported Apple identifiers, private-key paths, private-key material, or generated
  tokens

The `.p8` private key must remain outside the repository. This exception does not modify policy on
the Spotify or iTunes branches.

## Current Status

- Apple pilot authorized by repository policy
- Runtime configuration may proceed in a later milestone
- Provider implementation not started
- Live Apple access not yet authorized
- No provider request occurred in this milestone

See `docs/apple-music-pilot-authorization.md` for the branch-specific authorization record.
