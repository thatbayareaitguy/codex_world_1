"use client";

import { useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { ReleaseCard } from "./release-card";
import { formatArtistCredits, getReleaseGenreNames } from "../lib/public-catalog-display";
import type { PublicRelease, PublicReleaseStatus } from "../lib/public-catalog";

type ReleaseFilter = PublicReleaseStatus | "all";

interface ReleaseExplorerProps {
  readonly releases: readonly PublicRelease[];
}

const filters: readonly { label: string; value: ReleaseFilter }[] = [
  { label: "Released", value: "released" },
  { label: "Upcoming", value: "upcoming" },
  { label: "All", value: "all" },
];

const RELEASES_PER_PAGE = 50;

export function ReleaseExplorer({ releases }: ReleaseExplorerProps) {
  const [activeFilter, setActiveFilter] = useState<ReleaseFilter>("released");
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const [isPagePickerOpen, setIsPagePickerOpen] = useState(false);
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
  const pageCount = Math.max(1, Math.ceil(visibleReleases.length / RELEASES_PER_PAGE));
  const pageStart = (currentPage - 1) * RELEASES_PER_PAGE;
  const paginatedReleases = visibleReleases.slice(pageStart, pageStart + RELEASES_PER_PAGE);
  const firstVisibleRelease = visibleReleases.length === 0 ? 0 : pageStart + 1;
  const lastVisibleRelease = Math.min(pageStart + RELEASES_PER_PAGE, visibleReleases.length);

  function selectStatus(filter: ReleaseFilter) {
    setActiveFilter(filter);
    setCurrentPage(1);
    setIsPagePickerOpen(false);
  }

  function selectPage(page: number) {
    setCurrentPage(Math.min(Math.max(page, 1), pageCount));
    setIsPagePickerOpen(false);
    requestAnimationFrame(() => {
      document.getElementById("release-catalog-results")?.scrollIntoView({ block: "start" });
    });
  }

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
              onClick={() => selectStatus(filter.value)}
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
              onChange={(event) => {
                setQuery(event.target.value);
                setCurrentPage(1);
                setIsPagePickerOpen(false);
              }}
              placeholder="Filter releases"
            />
          </label>
          <label className="select-input">
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span className="sr-only">Filter by genre</span>
            <select
              value={genre}
              onChange={(event) => {
                setGenre(event.target.value);
                setCurrentPage(1);
                setIsPagePickerOpen(false);
              }}
            >
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
      <p id="release-catalog-results" className="result-count" aria-live="polite">
        {visibleReleases.length === 0
          ? "0 releases"
          : `Showing ${firstVisibleRelease} to ${lastVisibleRelease} of ${visibleReleases.length} ${
              visibleReleases.length === 1 ? "release" : "releases"
            }`}
      </p>
      {visibleReleases.length > 0 ? (
        <>
          <div className="release-grid catalog-grid">
            {paginatedReleases.map((release) => (
              <ReleaseCard key={release.publicId} release={release} />
            ))}
          </div>
          {pageCount > 1 ? (
            <nav className="catalog-pagination" aria-label="Release catalog pages">
              <p>
                Page {currentPage} of {pageCount}
              </p>
              <div className="pagination-pages">
                <button
                  type="button"
                  onClick={() => selectPage(currentPage - 1)}
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                {Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
                  <button
                    className={currentPage === page ? "active" : ""}
                    key={page}
                    type="button"
                    aria-current={currentPage === page ? "page" : undefined}
                    aria-label={`Go to page ${page}`}
                    onClick={() => selectPage(page)}
                  >
                    {page}
                  </button>
                ))}
                <div className="pagination-jump">
                  <button
                    className="pagination-more"
                    type="button"
                    aria-expanded={isPagePickerOpen}
                    aria-controls="release-page-picker"
                    aria-label="Choose a page"
                    onClick={() => setIsPagePickerOpen((isOpen) => !isOpen)}
                  >
                    ...
                  </button>
                  {isPagePickerOpen ? (
                    <div id="release-page-picker" className="pagination-page-picker">
                      <label>
                        <span>Choose page</span>
                        <select
                          aria-label="Choose page"
                          value={currentPage}
                          onChange={(event) => selectPage(Number(event.target.value))}
                        >
                          {Array.from({ length: pageCount }, (_, index) => index + 1).map(
                            (page) => (
                              <option key={page} value={page}>
                                Page {page}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => selectPage(currentPage + 1)}
                  disabled={currentPage === pageCount}
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </>
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
