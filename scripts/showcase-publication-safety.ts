import { catalogContentSha256 } from "../apps/showcase/lib/catalog-integrity";
import { contentForComparison, maximumCatalogBytes } from "../apps/showcase/lib/catalog-budget";
import { parsePublicCatalogSnapshot } from "../apps/showcase/lib/public-catalog-schema";

export function samePublication<
  T extends { readonly generatedAt: string },
  U extends { readonly generatedAt: string },
>(left: T, right: U): boolean {
  return (
    catalogContentSha256(contentForComparison(left)) ===
    catalogContentSha256(contentForComparison(right))
  );
}

export function validatePublicationChange(previousValue: unknown, nextValue: unknown): void {
  const previous = parsePublicCatalogSnapshot(previousValue);
  const next = parsePublicCatalogSnapshot(nextValue);
  if (next.artists.length === 0 || next.releases.length === 0)
    throw new Error("Refusing empty public catalog.");
  if (
    next.artists.length < previous.artists.length * 0.9 ||
    next.releases.length < previous.releases.length * 0.9
  ) {
    throw new Error(
      "Catalog count dropped by more than 10%; editorial review is required before publication.",
    );
  }
  // Leave room for PostgreSQL jsonb whitespace in the 8 MB bounded read.
  if (Buffer.byteLength(JSON.stringify(next)) > maximumCatalogBytes / 2)
    throw new Error("Catalog exceeds publication size budget.");
  const artistSlugs = new Set(next.artists.map((artist) => artist.slug));
  for (const release of next.releases) {
    if (
      release.artistCredits.some(
        (credit) => credit.artistSlug && !artistSlugs.has(credit.artistSlug),
      )
    ) {
      throw new Error("Catalog contains an unresolved artist-page reference.");
    }
  }
}
