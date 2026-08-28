"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { ReleaseCard } from "./release-card";
import {
  formatArtistCredits,
  getReleaseGenreNames,
  type PublicRelease,
  type PublicReleaseStatus,
} from "../lib/public-catalog";

type ReleaseFilter = PublicReleaseStatus | "all";

interface ReleaseExplorerProps {
  readonly releases: readonly PublicRelease[];
}

const filters: readonly { label: string; value: ReleaseFilter }[] = [
  { label: "Released", value: "released" },
  { label: "Upcoming", value: "upcoming" },
  { label: "All", value: "all" },
];

export function ReleaseExplorer({ releases }: ReleaseExplorerProps) {
  const [activeFilter, setActiveFilter] = useState<ReleaseFilter>("released");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("all");
  const genres = useMemo(
    () => [...new Set(releases.flatMap((release) => getReleaseGenreNames(release)))].sort(),
    [releases],
  );
  const visibleReleases = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return releases.filter((release) => {
      const matchesStatus = activeFilter === "all" || release.status === activeFilter;
      const releaseGenres = getReleaseGenreNames(release);
      const matchesGenre = genre === "all" || releaseGenres.includes(genre);
      const matchesQuery =
        normalizedQuery.length === 0 ||
        `${formatArtistCredits(release)} ${release.title} ${releaseGenres.join(" ")}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesStatus && matchesGenre && matchesQuery;
    });
  }, [activeFilter, genre, query, releases]);

  return (
    <section id="catalog" className="catalog-section" aria-labelledby="release-catalog-heading">
      <h2 id="release-catalog-heading" className="sr-only">
        Release catalog
      </h2>
      <div className="catalog-controls">
        <div className="filter-tabs" role="group" aria-label="Release status">
          {filters.map((filter) => (
            <button
              className={activeFilter === filter.value ? "active" : ""}
              key={filter.value}
              type="button"
              aria-pressed={activeFilter === filter.value}
              onClick={() => setActiveFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="catalog-inputs">
          <label className="search-input">
            <span className="sr-only">Filter releases</span>
            <Search size={15} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter releases"
            />
          </label>
          <label className="select-input">
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span className="sr-only">Filter by genre</span>
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
        {visibleReleases.length} {visibleReleases.length === 1 ? "release" : "releases"}
      </p>
      {visibleReleases.length > 0 ? (
        <div className="release-grid catalog-grid">
          {visibleReleases.map((release) => (
            <ReleaseCard key={release.publicId} release={release} />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <p className="kicker">NO MATCHES</p>
          <h3>Nothing fits those filters.</h3>
          <p>Try another status, genre, or search term.</p>
        </div>
      )}
    </section>
  );
}
