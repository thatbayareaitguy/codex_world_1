import Link from "next/link";
import { Artwork } from "./artwork";
import { formatPublicDate, type PublicRelease } from "../lib/public-catalog";

interface ReleaseCardProps {
  readonly release: PublicRelease;
}

export function ReleaseCard({ release }: ReleaseCardProps) {
  return (
    <article className="release-card" data-status={release.status}>
      <Link href={`/releases/${release.slug}`}>
        <Artwork label={release.title} tone={release.artworkTone} />
        <div className="release-card-line">
          <p className="meta">{release.status === "upcoming" ? "Upcoming" : release.type}</p>
          <time dateTime={release.releaseDate}>{formatPublicDate(release.releaseDate)}</time>
        </div>
        <h3>{release.title}</h3>
        <p>{release.artistName}</p>
      </Link>
    </article>
  );
}
