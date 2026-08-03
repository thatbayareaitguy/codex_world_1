# Full-Watchlist Apple Identity Seed Export Design

Prepared: 2026-08-03

## Boundary

This command exports public iTunes artist-ID candidates for later validation in the separate
Apple Music worktree. An exported ID is a candidate public catalog identity, not an Apple-confirmed
mapping. The command does not implement Apple Music, make an Apple request, modify production
discovery, or merge branches.

Every provider must be disabled. The command reads only the isolated iTunes database at
`127.0.0.1:55433/radar_itunes`, the frozen census artifact, and the tracked sanitized identity
inventory. It has no provider client or network call. It writes only the requested tracked JSON
artifact and Markdown review report.

## Frozen inputs

- Authoritative census: 593 complete active watched artists
- Census file SHA-256:
  `ee785fcc0831c462ea7e4dbd59fc7c6fc9fccde652c30739212e69740b1913fa`
- Census canonical SHA-256:
  `8b78dd990907e321f037ef16eb5b883ff369bea935d7024b22e0e7a9a184c33d`
- Tracked identity inventory: `docs/itunes-full-watchlist-identity-evidence.csv`
- Inventory SHA-256:
  `8852c14806bbb564c59642f67a6c84466c31ded165f4990e9dc5889c7ab087bb`
- Evidence cutoff: `2026-07-30T02:10:30.000Z`
- Existing corrected evidence-supported mappings: 13
- Existing normalized iTunes cache rows: 880
- Historical iTunes network requests: 880
- Approved aliases: 0
- Duplicate internal identities: 0
- Duplicate canonical names: 0

The source census contains terminal cached artist-search evidence for all 593 artists. It contains
at least one plausible exact canonical-name or approved-alias candidate for 592 artists. Taylor
Sherman has one returned artist result but no exact canonical-name or approved-alias match.

## Plan command

From the isolated iTunes worktree, with `RADAR_ENV_FILE` pointing to the ignored iTunes runtime
configuration:

```powershell
pnpm itunes:identity-export -- --plan `
  --census "$env:LOCALAPPDATA\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-search-census-2026-07-30T02-10-30Z.json" `
  --inventory "docs\itunes-full-watchlist-identity-evidence.csv" `
  --artifact "artifacts\apple-music-identity-seeds-v1.json" `
  --report "docs\apple-music-identity-seed-export.md" `
  --source-commit "<current-full-commit>"
```

Plan mode makes zero network requests and zero database writes. It validates the frozen hashes,
593 unique internal identities, duplicate canonical names, existing mappings, active run, lease,
cooldown, output paths, exact request forecast, runtime floor, and manual-review count.

The frozen plan result is:

| Classification             | Artists |
| :------------------------- | ------: |
| High-confidence seed       |     307 |
| Evidence-supported seed    |      13 |
| Ambiguous seed             |     272 |
| No candidate               |       0 |
| Manual review required     |       1 |
| Apple-side or human review |     273 |

The exact new-request forecast is 0 and the provider-request runtime floor is 0 ms. The current
3,200 ms pacing floor remains unchanged. If a later input has any artist without terminal cached
search evidence, execution fails closed and requires resuming the existing paced, durable census
workflow. The export command cannot issue that request itself.

## Execute command

Execution requires a clean `codex/itunes-discovery` worktree synchronized with its upstream at the
exact source commit:

```powershell
pnpm itunes:identity-export -- --execute `
  --census "$env:LOCALAPPDATA\TSNewMusicRadar\pilot-snapshots\itunes-full-watchlist-search-census-2026-07-30T02-10-30Z.json" `
  --inventory "docs\itunes-full-watchlist-identity-evidence.csv" `
  --artifact "artifacts\apple-music-identity-seeds-v1.json" `
  --report "docs\apple-music-identity-seed-export.md" `
  --source-commit "<pushed-pre-live-commit>" `
  --created-at "<canonical-ISO-timestamp>"
```

The command generates the artifact twice in memory, requires identical serialization, writes new
files without overwriting an existing artifact, rereads the isolated database, and verifies that
network-request, active-run, lease, and cooldown state did not change.

## Artifact contract

`artifacts/apple-music-identity-seeds-v1.json` uses schema version 1. It contains a stable internal
watched-artist identifier, canonical name, approved aliases, bounded public numeric candidate IDs,
an allowlisted public artist-page URL when available, candidate classification, confidence,
sanitized evidence-source labels, match-state fields, overlap counts, conflict counts, review
reason, and evidence timestamp.

Its self-hash covers recursively key-sorted compact JSON excluding only `artifactSelfHash`. The
input-watchlist hash covers the ordered stable internal identity, canonical name, and approved
aliases. The strict TypeScript parser validates both hashes, all counts, public numeric IDs, URL
hosts, alternate bounds, timestamps, and unique internal identities without database access.

The output excludes credentials, tokens, private-key paths, source-provider identifiers, raw
responses, artwork, previews, personal account data, unrelated logs, and machine-specific paths.

## Decision rules

- One exact normalized canonical-name result becomes a `high_confidence_seed` candidate.
- One exact approved-alias result may become a high-confidence candidate only when the alias is
  present in frozen project evidence.
- A previously corrected unique catalog-evidence mapping becomes an
  `evidence_supported_seed`. Only counts are transferred, not source-provider titles or IDs.
- Multiple exact-name candidates remain `ambiguous_seed`; all plausible IDs are retained up to
  the existing search limit of 10.
- A true empty result becomes `no_candidate`.
- Returned results with no exact canonical or approved-alias match become
  `manual_review_required` without a forced candidate.

Search rank, popularity, genre, partial-name similarity, and a single common title cannot confirm
identity.
