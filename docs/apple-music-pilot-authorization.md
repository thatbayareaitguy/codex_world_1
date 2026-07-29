# Apple Music Pilot Authorization

Date: 2026-07-29

## Authorization

The user approved the $99 Apple Developer Program experiment and a bounded Apple Music API proof
of concept on branch `codex/apple-music-discovery` in the isolated
`codex_world_1_apple` worktree.

The authorization is limited to Apple Music public catalog discovery. Developer-token
authentication may be used for public catalog requests only. The provider must remain disabled by
default.

## Required Gates

Credential-free tests must pass before any live request. A live Apple request also requires a
separate, explicitly bounded milestone that defines the request scope and limits. This policy
checkpoint does not authorize a live request.

Apple Team ID, Key ID, Media ID, private-key path, private-key contents, and generated developer
tokens must remain untracked and must not appear in logs or reports. The `.p8` private key must
remain outside the repository.

## Exclusions

This authorization does not permit:

- Music User Tokens
- Apple Music user-library or other personal-library access
- Playback
- Apple playlist access or writes
- Apple Music Feed
- Production scheduling or production integration
- A merge into `codex/release-radar-hardening`
- Spotify, iTunes, SoundCloud, MusicBrainz, Reddit, or any other provider activity
- Any other paid provider

The exception is branch-specific. It does not modify policy or authorize changes on the Spotify or
iTunes branches.
