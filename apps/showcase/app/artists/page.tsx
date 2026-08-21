import type { Metadata } from "next";
import { ArtistExplorer } from "../../components/artist-explorer";
import { publicCatalog } from "../../lib/public-catalog";

export const metadata: Metadata = {
  title: "Artists",
  description:
    "Discover electronic artists through structured genre, label, and release information.",
};

export default function ArtistsPage() {
  return (
    <div className="listing-page page-shell">
      <header className="listing-hero artist-listing-hero">
        <p className="kicker">
          <span /> ARTIST DISCOVERY
        </p>
        <h1>
          Follow the people
          <br />
          <em>behind the sound.</em>
        </h1>
        <p>
          Explore electronic artists through the releases they make, the scenes they move through,
          and the collaborators around them.
        </p>
      </header>
      <ArtistExplorer artists={publicCatalog.artists} />
    </div>
  );
}
