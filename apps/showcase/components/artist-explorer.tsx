"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { ArtistCard } from "./artist-card";
import { getArtistGenreNames, type PublicArtist } from "../lib/public-catalog";

interface ArtistExplorerProps {
  readonly artists: readonly PublicArtist[];
}

export function ArtistExplorer({ artists }: ArtistExplorerProps) {
  const [query, setQuery] = useState("");
  const visibleArtists = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return artists.filter((artist) =>
      `${artist.name} ${getArtistGenreNames(artist).join(" ")}`
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [artists, query]);

  return (
    <section className="catalog-section" aria-labelledby="artist-catalog-heading">
      <div className="catalog-controls artist-controls">
        <div>
          <h2 id="artist-catalog-heading">Artist index</h2>
          <p>{artists.length} published artists</p>
        </div>
        <label className="search-input">
          <span className="sr-only">Filter artists</span>
          <Search size={15} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by artist or genre"
          />
        </label>
      </div>
      <p className="result-count" aria-live="polite">
        Showing {visibleArtists.length}
      </p>
      {visibleArtists.length > 0 ? (
        <div className="artist-grid">
          {visibleArtists.map((artist) => (
            <ArtistCard artist={artist} key={artist.publicId} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p className="kicker">NO MATCHES</p>
          <h3>No artists found.</h3>
          <p>Try a different name or genre.</p>
        </div>
      )}
    </section>
  );
}
