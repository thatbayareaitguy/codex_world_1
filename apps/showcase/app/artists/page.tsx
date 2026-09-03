import type { Metadata } from "next";
import { ArtistExplorer } from "../../components/artist-explorer";
import { loadPublicCatalog } from "../../lib/catalog-source.server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Artists",
  description:
    "Discover electronic artists through structured genre, label, and release information.",
};

export default async function ArtistsPage() {
  const publicCatalog = await loadPublicCatalog();
  const releaseCounts = Object.fromEntries(
    publicCatalog.artists.map((artist) => [
      artist.slug,
      publicCatalog.releases.filter((release) =>
        release.artistCredits.some((credit) => credit.artistSlug === artist.slug),
      ).length,
    ]),
  );
  return (
    <div className="listing-page page-shell">
      <header className="listing-hero artist-listing-hero">
        <h1>
          Follow the people
          <br />
          <em>behind the sound.</em>
        </h1>
        <p>
          Explore the electronic artists we are following through the releases they make, the scenes
          they move through, and the genres they love.
        </p>
      </header>
      <ArtistExplorer artists={publicCatalog.artists} releaseCounts={releaseCounts} />
    </div>
  );
}
