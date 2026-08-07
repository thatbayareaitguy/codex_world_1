# Apple Artist Identity Ranking

Verified 2026-08-06.

## Evidence Boundary

The resolver never sends Spotify names, IDs, URLs, titles, ISRCs, UPCs, credits, or release
metadata to Apple, iTunes, MusicBrainz, Wikidata, or another provider. Spotify mappings are also
excluded from the Apple review API's independent-evidence section.

The historical iTunes seed artifact was audited before use:

- Path: `apps/scanner/src/apple-music-full-watchlist-identity-seeds-v1.json`
- Source branch: `codex/itunes-discovery`
- Source commit: `c6678a84868b30d8816b6095ff7f6feef0b89a91`
- Declared and recomputed canonical SHA-256:
  `0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660`

The artifact is intact, but its source documentation identifies frozen Spotify ground truth and
Spotify title overlap as inputs. It is therefore not sanctioned production identity evidence. Its
candidate IDs may remain as untrusted historical review inventory, but its scores, title overlaps,
and decisions are not used by this resolver.

Permitted evidence is limited to:

1. A direct Apple Music artist URL on an independently confirmed MusicBrainz identity.
2. A Wikidata Apple Music artist ID reached through that independently confirmed MusicBrainz
   identity.
3. Apple or iTunes catalog data fetched by an already known numeric Apple candidate ID.
4. Apple-only catalog properties used for ranking, never as an automatic identity anchor.

## Resolution Rules

Candidate catalogs preserve the Apple artist name and URL, artwork URL, genres, record labels,
copyright, release and song titles, dates, primary artist IDs, and direct co-credits. Remix and
version qualifiers remain part of normalized title comparison. Generic titles are downweighted.

Only one validated exact independent link can authorize automatic confirmation. It must identify a
single unclaimed Apple artist ID, have no contradiction, and win by at least 0.20. Multiple exact
IDs become a split-profile conflict. Apple-only genre, activity, label, catalog size, title, or
collaboration signals are capped below the automatic threshold and only rank manual-review cards.

A candidate is automatically eliminated only when its numeric Apple resource is directly proven
invalid. Inactivity, sparse catalogs, genre differences, language, and one-track profiles do not
eliminate candidates. Manual rejection is reversible.

## Calibration And Live Validation

The confirmed-mapping truth set that could be reconstructed from retained candidate history
contained 25 artist groups and 97 unique Apple candidates. The calibrated ranking produced:

- Top-1: 25 of 25
- Top-3: 25 of 25
- False automatic confirmations: 0
- True candidates eliminated: 0
- Soft-signal automatic confirmations: 0

This is a small retained-history sample, so it proves the configured safety checks for that sample,
not universal accuracy.

One bounded live pass evaluated 100 unresolved artists. It made 150 Apple-family numeric-ID lookup
requests at a configured minimum interval of 3200 ms, persisted 150 reusable candidate catalogs and
505 ranking rows, and had no provider failure or cooldown. It found no unique direct MusicBrainz or
Wikidata mapping and preserved one exact-link split-profile conflict. No Spotify request occurred.

## Operations

Run a bounded pass only after checking provider state:

```powershell
pnpm doctor
pnpm apple-music:identities resolve-pass --confirm-live --limit 100 --max-requests 150 --min-request-interval-ms 3200
```

The pass reuses persisted catalogs before making a request, persists each validated catalog and
ranking, continues past isolated candidate failures, and uses the Apple database-backed request
gate. Standard tests inject HTTP mocks and never call live providers.
