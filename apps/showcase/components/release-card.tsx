import Link from "next/link";
import { Artwork } from "./artwork";
import { formatPublicDate, getReleaseArtists, type PublicRelease } from "../lib/public-catalog";

interface ReleaseCardProps {
  readonly release: PublicRelease;
}

export function ReleaseCard({ release }: ReleaseCardProps) {
  const artistNames = getReleaseArtists(release)
    .map((artist) => artist.name)
    .join(" & ");

  return (
    <article className="release-card" data-status={release.status}>
      <Link href={`/releases/${release.slug}`}>
        <Artwork label={release.title} tone={release.artworkTone} />
        <div className="release-card-line">
          <p className="meta">{release.status === "upcoming" ? "Upcoming" : release.type}</p>
          <time dateTime={release.releaseDate}>{formatPublicDate(release.releaseDate)}</time>
        </div>
        <h3>{release.title}</h3>
        <p>{artistNames}</p>
      </Link>
    </article>
  );
}
