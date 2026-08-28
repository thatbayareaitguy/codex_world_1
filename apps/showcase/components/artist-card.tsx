import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Artwork } from "./artwork";
import { getArtistGenreNames, getArtistReleases, type PublicArtist } from "../lib/public-catalog";

interface ArtistCardProps {
  readonly artist: PublicArtist;
}

export function ArtistCard({ artist }: ArtistCardProps) {
  const releaseCount = getArtistReleases(artist.slug).length;
  const genres = getArtistGenreNames(artist);

  return (
    <article className="artist-card">
      <Link href={`/artists/${artist.slug}`}>
        <Artwork label={artist.name} tone={artist.artworkTone} size="artist" />
        <div className="artist-card-copy">
          <p className="meta">{genres[0] ?? "ARTIST"}</p>
          <h2>{artist.name}</h2>
          <p>
            {releaseCount} featured {releaseCount === 1 ? "release" : "releases"}
          </p>
        </div>
        <ArrowUpRight size={19} aria-hidden="true" />
      </Link>
    </article>
  );
}
