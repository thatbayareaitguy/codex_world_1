import type { Metadata } from "next";
import { ReleaseExplorer } from "../../components/release-explorer";
import { publicCatalog } from "../../lib/public-catalog";

export const metadata: Metadata = {
  title: "Releases",
  description: "Browse new, upcoming, and selected electronic music releases.",
};

export default function ReleasesPage() {
  return (
    <div className="listing-page page-shell">
      <header className="listing-hero">
        <p className="kicker">
          <span /> RELEASE RADAR
        </p>
        <h1>
          What is landing
          <br />
          <em>right now.</em>
        </h1>
        <p>Your gateway to discovering new EDM releases, artists, and bass music flare.</p>
      </header>
      <ReleaseExplorer releases={publicCatalog.releases} />
    </div>
  );
}
