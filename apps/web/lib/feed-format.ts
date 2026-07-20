interface FeedArtistCredit {
  creditedName: string;
  role: string;
}

export function formatFeedArtistCredits(credits: readonly FeedArtistCredit[]): string {
  const firstFeaturedIndex = credits.findIndex(
    (credit, index) => index > 0 && credit.role === "featured",
  );

  return credits
    .map((credit, index) =>
      index === firstFeaturedIndex ? `feat. ${credit.creditedName}` : credit.creditedName,
    )
    .join(", ");
}
