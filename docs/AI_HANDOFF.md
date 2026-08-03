# AI Handoff

Updated: 2026-08-03

This is the current source of truth for the isolated iTunes discovery worktree. It intentionally
excludes credentials, tokens, personal account data, private-key paths, raw provider responses,
artwork, previews, and unrelated runtime logs.

## Repository state

- Worktree: isolated iTunes worktree
- Branch: `codex/itunes-discovery`
- Milestone starting HEAD: `62bca506179fcbcd2bad9072fb8e7d2385e27d8b`
- Pushed pre-live export implementation: `c6678a84868b30d8816b6095ff7f6feef0b89a91`
- Upstream: `origin/codex/itunes-discovery`
- Current milestone: full-watchlist public iTunes artist-ID candidate export completed; final
  artifact and documentation commit is the commit containing this handoff
- Not merged

The separate Spotify and Apple Music worktrees were inspected only through Git status before and
after this milestone. They remained clean, synchronized, and on
`codex/release-radar-hardening` and `codex/apple-music-discovery`, respectively. Their files and
runtime databases were not modified or accessed.

## Result

The authoritative frozen census and tracked identity inventory contain 593 active watched
artists, zero duplicate internal identities, zero duplicate canonical names, and zero approved
aliases. All 593 artists have terminal cached iTunes artist-search evidence. Of those, 592 have at
least one plausible exact canonical-name or approved-alias candidate. Taylor Sherman has a
returned result but no exact canonical-name or approved-alias candidate, so no ID was forced.

Final candidate classifications:

| Classification          | Artists |
| :---------------------- | ------: |
| High-confidence seed    |     307 |
| Evidence-supported seed |      13 |
| Ambiguous seed          |     272 |
| No candidate            |       0 |
| Manual review required  |       1 |

The Apple-side or human review queue contains 273 artists: 272 ambiguous candidate sets plus the
one artist without an exact-name candidate. These are candidate public catalog identities, not
Apple-confirmed mappings.

## Artifacts

- Machine artifact: `artifacts/apple-music-identity-seeds-v1.json`
- Schema version: 1
- Storefront: `us`
- Input watchlist hash:
  `6006f18385e161c1acee5340dcb23ac46688f21b14e3b0e1de85e87e4ed586b0`
- Artifact self-hash:
  `0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660`
- File-byte SHA-256:
  `97e124947b49a9359438ff1fcd884adf59cad1666af91f9468983dec0356ed6e`
- Human review report: `docs/apple-music-identity-seed-export.md`
- Design and command contract: `docs/apple-music-identity-seed-export-design.md`
- Evidence cutoff: `2026-07-30T02:10:30.000Z`

The strict TypeScript parser independently verifies the artifact self-hash, input shape, 593
unique internal identities, classification totals, public numeric IDs, allowlisted public URLs,
timestamps, and the maximum 10 alternate IDs. The generated report contains one sanitized row for
each of the 273 review artists and does not reproduce candidate-ID lists.

## Candidate rules

- One exact normalized canonical-name or approved-alias result becomes a high-confidence seed,
  not a confirmed Apple mapping.
- The 13 evidence-supported seeds reuse the prior corrected iTunes catalog-evidence resolver.
  Only overlap and conflict counts are exported; source-provider titles and identifiers are not.
- Multiple exact candidates remain ambiguous, with all plausible public IDs retained up to the
  existing search limit of 10.
- Search rank, popularity, genre, partial-name similarity, and a single common title cannot
  confirm identity.
- No candidate is forced to increase coverage.

## Runtime and isolation

- Isolated main database: `radar_itunes` on loopback port 55433
- Isolated test database: `radar_itunes_test` on loopback port 55434
- Applied migrations: 18
- Historical iTunes network requests before export: 880
- Historical iTunes network requests after export: 880
- Normalized response-cache rows: 880
- Total historical request-event rows before export: 1,051
- New export requests: 0
- Provider-request runtime: 0 ms
- Active iTunes runs after export: 0
- Active iTunes leases after export: 0
- Active iTunes cooldown after export: 0
- `ITUNES_DISCOVERY_ENABLED=false`
- Spotify, MusicBrainz, Reddit, and SoundCloud controls disabled
- No Apple Music provider exists in this worktree

The export command has no provider client or network path. It reads the isolated database and
frozen artifacts, then writes only the requested JSON and Markdown outputs. If future census input
is incomplete, it fails closed and requires the existing paced, durable census workflow instead
of issuing a request itself.

## Verification

- Formatting: passed
- ESLint: passed with zero warnings
- Strict TypeScript: passed across all workspace packages
- Focused identity-export tests: 20 passed
- Unit tests: 431 passed in 52 files
- PostgreSQL integration tests: 85 passed in 16 files on the complete rerun
- The first integration attempt had the previously documented transient mocked Reddit assertion;
  no source changed, and the complete rerun passed
- Production build: passed
- Mock-only Playwright: 23 passed
- Migration generation: no schema changes and no migration created
- Doctor: overall `READY`, 18 migrations, loopback application port available
- Artifact self-hash: passed
- Input watchlist and classification totals: passed
- Public numeric ID and alternate-list bounds: passed
- `git diff --check`: passed
- Secret and private-path review: passed

No verification command contacted an external provider.

## Next step

The separate paid Apple Music branch may import this immutable artifact, verify its self-hash,
match every stable watched-artist identifier, validate candidate IDs through Apple catalog lookup,
confirm only compatible canonical names or approved aliases, preserve ambiguous alternatives, and
produce a smaller manual-review queue.

Apple validation has not occurred. Production integration, scanning, scheduling, feed changes,
playlist behavior, and merging remain unauthorized.
