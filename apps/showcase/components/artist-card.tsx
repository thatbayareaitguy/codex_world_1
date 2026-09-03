import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Artwork } from "./artwork";
import { getArtistGenreNames } from "../lib/public-catalog-display";
import type { PublicArtist } from "../lib/public-catalog";

interface ArtistCardProps {
  readonly artist: PublicArtist;
  readonly releaseCount: number;
}

export function ArtistCard({ artist, releaseCount }: ArtistCardProps) {
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
