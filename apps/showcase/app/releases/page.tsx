import type { Metadata } from "next";
import { ReleaseExplorer } from "../../components/release-explorer";
import { loadPublicCatalog } from "../../lib/catalog-source.server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Releases",
  description: "Browse new, upcoming, and selected electronic music releases.",
};

export default async function ReleasesPage() {
  const publicCatalog = await loadPublicCatalog();
  return (
    <div className="listing-page page-shell">
      <header className="listing-hero">
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
