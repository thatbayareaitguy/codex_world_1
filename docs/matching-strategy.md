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
