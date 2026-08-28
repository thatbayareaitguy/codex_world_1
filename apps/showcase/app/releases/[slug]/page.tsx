import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { Artwork } from "../../../components/artwork";
import { ProviderLinks } from "../../../components/provider-links";
import { ReleaseCard } from "../../../components/release-card";
import { formatPublicDate, getRelease, publicCatalog } from "../../../lib/public-catalog";

interface ReleasePageProps {
  readonly params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return publicCatalog.releases.map((release) => ({ slug: release.slug }));
}

export async function generateMetadata({ params }: ReleasePageProps): Promise<Metadata> {
  const release = getRelease((await params).slug);
  if (release === undefined)
    return { title: "Release not found", openGraph: { images: [] }, twitter: { images: [] } };
  const description = `${release.title} by ${release.artistName}. ${release.type}, released ${formatPublicDate(release.releaseDate)}.`;
  return {
    title: release.title,
    description,
    openGraph: { title: `${release.title} | Showcase`, description, images: [] },
    twitter: { card: "summary", title: `${release.title} | Showcase`, description, images: [] },
  };
}

export default async function ReleaseDetailPage({ params }: ReleasePageProps) {
  const release = getRelease((await params).slug);
  if (release === undefined) notFound();
  const artist = publicCatalog.artists.find(
    (item) => item.name.localeCompare(release.artistName, undefined, { sensitivity: "base" }) === 0,
  );
  const related = publicCatalog.releases
    .filter(
      (item) =>
        item.publicId !== release.publicId &&
        item.genres.some((genre) => release.genres.includes(genre)),
    )
    .slice(0, 3);

  return (
    <div className="detail-page page-shell">
      <Link className="back-link" href="/releases">
        <ArrowLeft size={14} /> All releases
      </Link>
      <section className="release-detail-hero">
        <Artwork label={release.title} tone={release.artworkTone} size="detail" />
        <div className="detail-copy">
          <p className="kicker">
            {release.status === "upcoming" ? "UPCOMING RELEASE" : release.type.toUpperCase()}
          </p>
          <h1>{release.title}</h1>
          <p className="detail-artists">
            {artist === undefined ? (
              release.artistName
            ) : (
              <Link href={`/artists/${artist.slug}`}>{artist.name}</Link>
            )}
          </p>
          <dl className="fact-grid">
            <div>
              <dt>Release date</dt>
              <dd>
                <time dateTime={release.releaseDate}>{formatPublicDate(release.releaseDate)}</time>
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{release.type}</dd>
            </div>
            <div>
              <dt>Genre</dt>
              <dd>{release.genres.join(" / ")}</dd>
            </div>
            <div>
              <dt>Label</dt>
              <dd>{release.label ?? "Not listed"}</dd>
            </div>
            <div>
              <dt>Discovered</dt>
              <dd>{formatPublicDate(release.firstDiscoveredDate)}</dd>
            </div>
          </dl>
          <ProviderLinks links={release.links} />
        </div>
      </section>
      <section className="track-section">
        <div>
          <p className="kicker">TRACK LIST</p>
          <h2>
            {release.tracks.length} {release.tracks.length === 1 ? "track" : "tracks"}
          </h2>
        </div>
        <ol>
          {release.tracks.map((track) => (
            <li key={`${track.discNumber}-${track.position}`}>
              <span>{String(track.position).padStart(2, "0")}</span>
              <strong>{track.title}</strong>
            </li>
          ))}
        </ol>
      </section>
      {related.length > 0 ? (
        <section className="related-section">
          <div className="section-heading">
            <div>
              <p className="kicker">KEEP EXPLORING</p>
              <h2>Related releases</h2>
            </div>
          </div>
          <div className="release-grid">
            {related.map((item) => (
              <ReleaseCard key={item.publicId} release={item} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
