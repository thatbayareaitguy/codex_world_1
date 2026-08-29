import Link from "next/link";
import { Artwork } from "./artwork";
import {
  formatArtistCredits,
  formatPublicDate,
  getReleaseGenreNames,
  type PublicRelease,
} from "../lib/public-catalog";

interface ReleaseCardProps {
  readonly release: PublicRelease;
}

export function ReleaseCard({ release }: ReleaseCardProps) {
  const genres = getReleaseGenreNames(release);
  return (
    <article className="release-card" data-status={release.status}>
      <Artwork
        appleMusicUrl={release.links.appleMusic}
        artwork={release.artwork}
        label={release.title}
        tone={release.artworkTone}
      />
      <Link className="release-card-copy" href={`/releases/${release.slug}`}>
        <div className="release-card-line">
          <p className="meta">{release.status === "upcoming" ? "Upcoming" : release.type}</p>
          <time dateTime={release.releaseDate}>{formatPublicDate(release.releaseDate)}</time>
        </div>
        <h3>{release.title}</h3>
        <p>{formatArtistCredits(release)}</p>
        {genres.length > 0 ? <p className="release-card-genres">{genres.join(" / ")}</p> : null}
      </Link>
    </article>
  );
}
