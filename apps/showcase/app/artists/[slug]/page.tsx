import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { Artwork } from "../../../components/artwork";
import { ProviderLinks } from "../../../components/provider-links";
import { ReleaseCard } from "../../../components/release-card";
import { getArtist, getArtistReleases, publicCatalog } from "../../../lib/public-catalog";

interface ArtistPageProps {
  readonly params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return publicCatalog.artists.map((artist) => ({ slug: artist.slug }));
}

export async function generateMetadata({ params }: ArtistPageProps): Promise<Metadata> {
  const artist = getArtist((await params).slug);
  if (artist === undefined)
    return { title: "Artist not found", openGraph: { images: [] }, twitter: { images: [] } };
  const description = `${artist.name} on Showcase. Explore ${artist.genres.join(", ")} releases, labels, and collaborators.`;
  return {
    title: artist.name,
    description,
    openGraph: { title: `${artist.name} | Showcase`, description, images: [] },
    twitter: { card: "summary", title: `${artist.name} | Showcase`, description, images: [] },
  };
}

export default async function ArtistDetailPage({ params }: ArtistPageProps) {
  const artist = getArtist((await params).slug);
  if (artist === undefined) notFound();
  const releases = getArtistReleases(artist.slug);
  const recent = releases.filter((release) => release.status !== "upcoming");
  const upcoming = releases.filter((release) => release.status === "upcoming");
  const related = artist.relatedArtistSlugs.flatMap((slug) => {
    const item = getArtist(slug);
    return item === undefined ? [] : [item];
  });

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
          <div className="tag-list">
            {artist.genres.map((genre) => (
              <span key={genre}>{genre}</span>
            ))}
          </div>
          <dl className="fact-grid artist-facts">
            <div>
              <dt>Featured releases</dt>
              <dd>{releases.length}</dd>
            </div>
            <div>
              <dt>Label associations</dt>
              <dd>
                {artist.labelAssociations.length > 0
                  ? artist.labelAssociations.join(" / ")
                  : "Independent"}
              </dd>
            </div>
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
                <span>{item.genres[0]}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
