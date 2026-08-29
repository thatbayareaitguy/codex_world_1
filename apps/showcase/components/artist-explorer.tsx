"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { ArtistCard } from "./artist-card";
import { getArtistGenreNames, type PublicArtist } from "../lib/public-catalog";

interface ArtistExplorerProps {
  readonly artists: readonly PublicArtist[];
}

export function ArtistExplorer({ artists }: ArtistExplorerProps) {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("all");
  const genres = useMemo(
    () => [...new Set(artists.flatMap((artist) => getArtistGenreNames(artist)))].sort(),
    [artists],
  );
  const visibleArtists = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return artists.filter((artist) => {
      const artistGenres = getArtistGenreNames(artist);
      const matchesGenre = genre === "all" || artistGenres.includes(genre);
      const matchesQuery =
        normalizedQuery.length === 0 || artist.name.toLowerCase().includes(normalizedQuery);
      return matchesGenre && matchesQuery;
    });
  }, [artists, genre, query]);

  return (
    <section className="catalog-section" aria-labelledby="artist-catalog-heading">
      <div className="catalog-controls artist-controls">
        <div>
          <h2 id="artist-catalog-heading">Artist index</h2>
          <p>{artists.length} published artists</p>
        </div>
        <div className="catalog-inputs">
          <label className="search-input">
            <span className="sr-only">Search artists</span>
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
            />
          </label>
          <label className="select-input">
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span className="sr-only">Filter artists by genre</span>
            <select value={genre} onChange={(event) => setGenre(event.target.value)}>
              <option value="all">All genres</option>
              {genres.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
        </div>
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
