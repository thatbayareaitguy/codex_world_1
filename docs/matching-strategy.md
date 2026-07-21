# Matching Strategy

Algorithm version: `v2-real-providers`.

## Ordered Rules

1. Exact provider track ID in the same provider: `1.00`, automatic.
2. Exact normalized ISRC: `1.00`, automatic across providers.
3. Exact UPC or EAN plus disc and track position: `0.99`, automatic.
4. Exact MusicBrainz recording or release-group relationship: `0.98`, automatic.
5. Exact normalized title, ordered canonical credits, compatible version, and duration within two seconds: automatic only at `0.93` or higher with no tied candidate or conflict.
6. Manual review.

Title-only matching is never export eligible. Metadata scoring assigns 0.45 to title, 0.30 to ordered credits, 0.15 to version agreement, and 0.10 to duration tolerance.

Unicode uses NFKC normalization, case folds, punctuation becomes spacing, whitespace collapses, and identifier formatting is removed. Credited names are preserved. Remix, live, radio edit, extended mix, clean, explicit, demo, acoustic, instrumental, and remaster markers remain semantic and conflicting versions do not collapse.

Canonical display values prefer explicit user edits, then manually confirmed mappings, then exact identifier-backed source values. Provider dates, titles, classifications, IDs, URLs, and conflicting values remain inspectable in provider records and source evidence. Every decision stores confidence, reasons, rule, and algorithm version.

Recording matching and release membership are separate decisions. An exact ISRC, provider track ID, or MusicBrainz recording ID may reuse one canonical track while candidate provenance creates another release appearance. The feed shows each distinct proven appearance, including a single followed by an album appearance, rather than treating the track's deprecated `release_id` as authoritative.

`Keep separate` is a positive manual identity decision, not rejection. It creates or preserves a distinct canonical recording, retains the candidate, evidence, feed row, release appearance, and manual timestamp, and prevents the candidate from being merged again. If an identifier is already uniquely assigned to the proposed recording, the separate recording leaves that canonical identifier unset while the conflicting observed identifier remains preserved in candidate provenance.
