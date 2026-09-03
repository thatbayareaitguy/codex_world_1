import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { Artwork } from "../../../components/artwork";
import { ProviderLinks } from "../../../components/provider-links";
import { ReleaseCard } from "../../../components/release-card";
import { loadPublicCatalog } from "../../../lib/catalog-source.server";
import {
  getArtist,
  getArtistGenreNames,
  getArtistReleases,
  getRelatedArtists,
} from "../../../lib/public-catalog";

export const dynamic = "force-dynamic";

interface ArtistPageProps {
  readonly params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: ArtistPageProps): Promise<Metadata> {
  const publicCatalog = await loadPublicCatalog();
  const artist = getArtist((await params).slug, publicCatalog);
  if (artist === undefined)
    return { title: "Artist not found", openGraph: { images: [] }, twitter: { images: [] } };
  const genres = getArtistGenreNames(artist);
  const description = `${artist.name} on Showcase. Explore ${genres.length ? `${genres.join(", ")} music` : "new electronic music"}, releases, and collaborators.`;
  return {
    title: artist.name,
    description,
    openGraph: { title: `${artist.name} | Showcase`, description, images: [] },
    twitter: { card: "summary", title: `${artist.name} | Showcase`, description, images: [] },
  };
}

export default async function ArtistDetailPage({ params }: ArtistPageProps) {
  const publicCatalog = await loadPublicCatalog();
  const artist = getArtist((await params).slug, publicCatalog);
  if (artist === undefined) notFound();
  const genres = getArtistGenreNames(artist);
  const releases = getArtistReleases(artist.slug, publicCatalog);
  const recent = releases.filter((release) => release.status !== "upcoming");
  const upcoming = releases.filter((release) => release.status === "upcoming");
  const related = getRelatedArtists(artist.slug, publicCatalog);

  return (
    <div className="detail-page page-shell">
      <Link className="back-link" href="/artists">
        <ArrowLeft size={14} /> All artists
      </Link>
      <section className="artist-detail-hero">
        <Artwork label={artist.name} tone={artist.artworkTone} size="detail" />
        <div className="detail-copy">
          <p className="kicker">ARTIST PROFILE</p>
          <h1>{artist.name}</h1>
          {genres.length > 0 ? (
            <div className="tag-list">
              {genres.map((genre) => (
                <span key={genre}>{genre}</span>
              ))}
            </div>
          ) : null}
          <dl className="fact-grid artist-facts">
            <div>
              <dt>Featured releases</dt>
              <dd>{releases.length}</dd>
            </div>
            {artist.labelAssociations?.length ? (
              <div>
                <dt>Label associations</dt>
                <dd>{artist.labelAssociations.join(" / ")}</dd>
              </div>
            ) : null}
          </dl>
          <ProviderLinks links={artist.links} />
        </div>
      </section>
      {upcoming.length > 0 ? (
        <section className="related-section">
          <div className="section-heading">
            <div>
              <p className="kicker">COMING NEXT</p>
              <h2>Upcoming</h2>
            </div>
          </div>
          <div className="release-grid">
            {upcoming.map((release) => (
              <ReleaseCard key={release.publicId} release={release} />
            ))}
          </div>
        </section>
      ) : null}
      <section className="related-section">
        <div className="section-heading">
          <div>
            <p className="kicker">CATALOG</p>
            <h2>Recent releases</h2>
          </div>
        </div>
        {recent.length > 0 ? (
          <div className="release-grid">
            {recent.map((release) => (
              <ReleaseCard key={release.publicId} release={release} />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <h3>No recent releases yet.</h3>
            <p>New catalog entries will appear here.</p>
          </div>
        )}
      </section>
      {related.length > 0 ? (
        <section className="collaborator-section">
          <p className="kicker">RELATED &amp; COLLABORATING</p>
          <div className="collaborator-list">
            {related.map((item) => (
              <Link href={`/artists/${item.slug}`} key={item.publicId}>
                {item.name}
                <span>{getArtistGenreNames(item)[0] ?? "Artist"}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
