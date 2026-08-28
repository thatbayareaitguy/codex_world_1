"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Search } from "lucide-react";

import type { GenreReviewDataset } from "../lib/genre-editorial-contract";

interface GenreReviewManagerProps {
  readonly initialDataset: GenreReviewDataset;
}

function sameGenres(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slug) => right.includes(slug));
}

export function GenreReviewManager({ initialDataset }: GenreReviewManagerProps) {
  const [dataset, setDataset] = useState(initialDataset);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(initialDataset.artists[0]?.publicId ?? "");
  const selectedArtist = dataset.artists.find((artist) => artist.publicId === selectedId);
  const [draftGenres, setDraftGenres] = useState<readonly string[]>(
    selectedArtist?.genreSlugs ?? [],
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => {
    setDraftGenres(selectedArtist?.genreSlugs ?? []);
    setSaveState("idle");
  }, [selectedArtist?.publicId, selectedArtist?.genreSlugs]);

  const filteredArtists = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === "") return dataset.artists;
    const genreNames = new Map(dataset.taxonomy.map((genre) => [genre.slug, genre.name]));
    return dataset.artists.filter((artist) =>
      [
        artist.name,
        ...artist.labelAssociations,
        ...artist.genreSlugs.map((slug) => genreNames.get(slug) ?? slug),
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [dataset, query]);

  const isDirty =
    selectedArtist !== undefined && !sameGenres(draftGenres, selectedArtist.genreSlugs);

  function selectArtist(publicId: string): void {
    setSelectedId(publicId);
  }

  function toggleGenre(slug: string): void {
    setDraftGenres((current) =>
      current.includes(slug)
        ? current.filter((candidate) => candidate !== slug)
        : [...current, slug],
    );
    setSaveState("idle");
  }

  async function saveAndNext(): Promise<void> {
    if (selectedArtist === undefined) return;
    setSaveState("saving");
    try {
      const response = await fetch("/api/local/genre-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicId: selectedArtist.publicId, genreSlugs: draftGenres }),
      });
      if (!response.ok) throw new Error("The genre assignment could not be saved.");
      const nextDataset = (await response.json()) as GenreReviewDataset;
      const nextArtist =
        nextDataset.artists.find(
          (artist) => artist.publicId !== selectedArtist.publicId && artist.genreSlugs.length === 0,
        ) ??
        nextDataset.artists.find((artist) => artist.publicId !== selectedArtist.publicId) ??
        nextDataset.artists[0];
      setDataset(nextDataset);
      setSelectedId(nextArtist?.publicId ?? "");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="genre-admin-layout">
      <aside className="genre-admin-sidebar" aria-label="Artist review queue">
        <div className="genre-admin-counts">
          <p>
            <strong>{dataset.unclassifiedCount}</strong> unclassified
          </p>
          <p>
            <strong>{dataset.classifiedCount}</strong> classified
          </p>
        </div>
        <label className="genre-admin-search">
          <span className="sr-only">Search artists</span>
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artists"
          />
        </label>
        <p className="genre-admin-result-count" aria-live="polite">
          {filteredArtists.length} artists
        </p>
        <div className="genre-admin-artist-list">
          {filteredArtists.map((artist) => (
            <button
              type="button"
              className={artist.publicId === selectedId ? "is-selected" : undefined}
              onClick={() => selectArtist(artist.publicId)}
              key={artist.publicId}
            >
              <span>{artist.name}</span>
              <small className={artist.genreSlugs.length > 0 ? "is-confirmed" : "is-open"}>
                {artist.genreSlugs.length > 0
                  ? `${artist.genreSlugs.length} confirmed`
                  : "Needs review"}
              </small>
            </button>
          ))}
        </div>
      </aside>

      <section className="genre-admin-editor" aria-live="polite">
        {selectedArtist === undefined ? (
          <div className="genre-admin-empty">
            <h2>No artist selected</h2>
            <p>Choose an artist from the review queue.</p>
          </div>
        ) : (
          <>
            <header className="genre-admin-artist-header">
              <div>
                <p className="kicker">EDITORIAL GENRE REVIEW</p>
                <h2>{selectedArtist.name}</h2>
                {selectedArtist.labelAssociations.length > 0 && (
                  <p>Labels: {selectedArtist.labelAssociations.join(", ")}</p>
                )}
              </div>
              <span
                className={
                  selectedArtist.genreSlugs.length > 0
                    ? "genre-status genre-status-confirmed"
                    : "genre-status genre-status-open"
                }
              >
                {selectedArtist.genreSlugs.length > 0 ? "Confirmed" : "Unclassified"}
              </span>
            </header>

            <div className="genre-admin-section genre-admin-confirmed">
              <div>
                <p className="genre-admin-eyebrow">Published / confirmed genres</p>
                <p className="genre-admin-help">
                  Your saved selection is authoritative Showcase editorial data.
                </p>
              </div>
              <div className="genre-toggle-grid" role="group" aria-label="Genre assignments">
                {dataset.taxonomy.map((genre) => {
                  const isActive = draftGenres.includes(genre.slug);
                  return (
                    <button
                      type="button"
                      className={isActive ? "genre-toggle is-active" : "genre-toggle"}
                      aria-pressed={isActive}
                      onClick={() => toggleGenre(genre.slug)}
                      key={genre.slug}
                    >
                      {isActive && <Check size={14} aria-hidden="true" />}
                      {genre.name}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="genre-admin-section genre-admin-suggestion">
              <div className="genre-suggestion-heading">
                <div>
                  <p className="genre-admin-eyebrow">Research suggestion</p>
                  <p className="genre-admin-help">
                    Suggestions are private and never publish automatically.
                  </p>
                </div>
                {selectedArtist.suggestion !== undefined && (
                  <span className={`confidence confidence-${selectedArtist.suggestion.confidence}`}>
                    {selectedArtist.suggestion.confidence} confidence
                  </span>
                )}
              </div>
              {selectedArtist.suggestion === undefined ? (
                <p>No suggestion is needed for this classified artist.</p>
              ) : (
                <>
                  <div className="suggested-genre-list">
                    {selectedArtist.suggestion.genreSlugs.map((slug) => (
                      <span key={slug}>
                        {dataset.taxonomy.find((genre) => genre.slug === slug)?.name ?? slug}
                      </span>
                    ))}
                  </div>
                  <p>{selectedArtist.suggestion.evidenceSummary}</p>
                  {selectedArtist.suggestion.sources.length > 0 && (
                    <ul className="genre-source-list">
                      {selectedArtist.suggestion.sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button
                    type="button"
                    className="genre-use-suggestion"
                    onClick={() => {
                      setDraftGenres(selectedArtist.suggestion?.genreSlugs ?? []);
                      setSaveState("idle");
                    }}
                  >
                    Use suggestion as draft
                  </button>
                </>
              )}
            </div>

            <footer className="genre-admin-actions">
              <p role="status">
                {saveState === "error"
                  ? "Save failed. Your current draft is still on screen."
                  : isDirty
                    ? "Unsaved changes"
                    : "No unsaved changes"}
              </p>
              <button
                type="button"
                className="button button-primary"
                disabled={saveState === "saving"}
                onClick={() => void saveAndNext()}
              >
                {saveState === "saving" ? "Saving..." : "Save & Next"}
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
