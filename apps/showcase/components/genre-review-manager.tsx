"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Check, Search } from "lucide-react";

import type { GenreReviewDataset } from "../lib/genre-editorial-contract";

interface GenreReviewManagerProps {
  readonly initialDataset: GenreReviewDataset;
}

type ClassificationFilter = "unclassified" | "classified";
type ConfidenceFilter = "all" | "high" | "medium" | "low";

function sameGenres(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((slug) => right.includes(slug));
}

function filterArtists(
  dataset: GenreReviewDataset,
  classificationFilter: ClassificationFilter,
  query: string,
  confidenceFilter: ConfidenceFilter,
): GenreReviewDataset["artists"] {
  const normalizedQuery = query.trim().toLowerCase();
  const genreNames = new Map(dataset.taxonomy.map((genre) => [genre.slug, genre.name]));

  return dataset.artists.filter((artist) => {
    const isClassified = artist.genreSlugs.length > 0;
    if (isClassified !== (classificationFilter === "classified")) return false;
    if (confidenceFilter !== "all" && artist.suggestion?.confidence !== confidenceFilter) {
      return false;
    }
    if (normalizedQuery === "") return true;

    return [
      artist.name,
      ...artist.labelAssociations,
      ...artist.genreSlugs.map((slug) => genreNames.get(slug) ?? slug),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function GenreReviewManager({ initialDataset }: GenreReviewManagerProps) {
  const [dataset, setDataset] = useState(initialDataset);
  const [query, setQuery] = useState("");
  const [classificationFilter, setClassificationFilter] =
    useState<ClassificationFilter>("unclassified");
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [selectedId, setSelectedId] = useState(
    initialDataset.artists.find((artist) => artist.genreSlugs.length === 0)?.publicId ?? "",
  );
  const selectedArtist = dataset.artists.find((artist) => artist.publicId === selectedId);
  const [draftGenres, setDraftGenres] = useState<readonly string[]>(
    selectedArtist?.genreSlugs ?? [],
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [bulkSaving, setBulkSaving] = useState(false);

  useEffect(() => {
    setDraftGenres(selectedArtist?.genreSlugs ?? []);
    setSaveState("idle");
  }, [selectedArtist?.publicId, selectedArtist?.genreSlugs]);

  const filteredArtists = useMemo(
    () => filterArtists(dataset, classificationFilter, query, confidenceFilter),
    [classificationFilter, confidenceFilter, dataset, query],
  );

  const isDirty =
    selectedArtist !== undefined && !sameGenres(draftGenres, selectedArtist.genreSlugs);

  function selectArtist(publicId: string): void {
    setSelectedId(publicId);
  }

  function selectClassification(nextFilter: ClassificationFilter): void {
    if (nextFilter === classificationFilter) return;
    setClassificationFilter(nextFilter);
    setConfidenceFilter("all");
    setSelectedId(filterArtists(dataset, nextFilter, query, "all")[0]?.publicId ?? "");
  }

  function searchArtists(nextQuery: string): void {
    setQuery(nextQuery);
    const nextArtists = filterArtists(dataset, classificationFilter, nextQuery, confidenceFilter);
    if (!nextArtists.some((artist) => artist.publicId === selectedId)) {
      setSelectedId(nextArtists[0]?.publicId ?? "");
    }
  }

  function selectConfidence(nextFilter: ConfidenceFilter): void {
    setConfidenceFilter(nextFilter);
    setSelectedId(
      filterArtists(dataset, classificationFilter, query, nextFilter)[0]?.publicId ?? "",
    );
  }

  function navigateClassificationTabs(event: KeyboardEvent<HTMLButtonElement>): void {
    let nextFilter: ClassificationFilter | undefined;
    if (event.key === "Home") nextFilter = "unclassified";
    if (event.key === "End") nextFilter = "classified";
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      nextFilter = classificationFilter === "unclassified" ? "classified" : "unclassified";
    }
    if (nextFilter === undefined) return;

    event.preventDefault();
    selectClassification(nextFilter);
    document.getElementById(`genre-review-${nextFilter}-tab`)?.focus();
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
        body: JSON.stringify({
          action: "save",
          publicId: selectedArtist.publicId,
          genreSlugs: draftGenres,
        }),
      });
      if (!response.ok) throw new Error("The genre assignment could not be saved.");
      const nextDataset = (await response.json()) as GenreReviewDataset;
      const currentIndex = filteredArtists.findIndex(
        (artist) => artist.publicId === selectedArtist.publicId,
      );
      const nextQueue = filterArtists(nextDataset, classificationFilter, query, confidenceFilter);
      const savedArtistIndex = nextQueue.findIndex(
        (artist) => artist.publicId === selectedArtist.publicId,
      );
      const nextArtist =
        savedArtistIndex >= 0
          ? nextQueue[(savedArtistIndex + 1) % nextQueue.length]
          : nextQueue[Math.min(Math.max(currentIndex, 0), nextQueue.length - 1)];
      setDataset(nextDataset);
      setSelectedId(nextArtist?.publicId ?? "");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function skipAndNext(): Promise<void> {
    if (selectedArtist === undefined) return;
    setSaveState("saving");
    try {
      const response = await fetch("/api/local/genre-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "skip", publicId: selectedArtist.publicId }),
      });
      if (!response.ok) throw new Error("The artist could not be skipped.");
      const nextDataset = (await response.json()) as GenreReviewDataset;
      const nextQueue = filterArtists(nextDataset, classificationFilter, query, confidenceFilter);
      const currentIndex = filteredArtists.findIndex(
        (artist) => artist.publicId === selectedArtist.publicId,
      );
      const nextArtist = nextQueue[(Math.max(currentIndex, 0) + 1) % Math.max(nextQueue.length, 1)];
      setDataset(nextDataset);
      setSelectedId(nextArtist?.publicId ?? "");
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  async function bulkConfirmHigh(): Promise<void> {
    setBulkSaving(true);
    try {
      const response = await fetch("/api/local/genre-reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "bulk-confirm-high" }),
      });
      if (!response.ok) throw new Error("Eligible HIGH suggestions could not be confirmed.");
      const nextDataset = (await response.json()) as GenreReviewDataset;
      setDataset(nextDataset);
      setSelectedId(
        filterArtists(nextDataset, classificationFilter, query, confidenceFilter)[0]?.publicId ??
          "",
      );
      setSaveState("saved");
    } catch {
      setSaveState("error");
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <div className="genre-admin-layout">
      <aside className="genre-admin-sidebar" aria-label="Artist review queue">
        <div className="genre-admin-counts" role="tablist" aria-label="Artist classification">
          <button
            type="button"
            id="genre-review-unclassified-tab"
            role="tab"
            aria-controls="genre-review-artist-list"
            aria-selected={classificationFilter === "unclassified"}
            tabIndex={classificationFilter === "unclassified" ? 0 : -1}
            className={classificationFilter === "unclassified" ? "is-active" : undefined}
            onClick={() => selectClassification("unclassified")}
            onKeyDown={navigateClassificationTabs}
          >
            <strong>{dataset.unclassifiedCount}</strong>
            <span>unclassified</span>
          </button>
          <button
            type="button"
            id="genre-review-classified-tab"
            role="tab"
            aria-controls="genre-review-artist-list"
            aria-selected={classificationFilter === "classified"}
            tabIndex={classificationFilter === "classified" ? 0 : -1}
            className={classificationFilter === "classified" ? "is-active" : undefined}
            onClick={() => selectClassification("classified")}
            onKeyDown={navigateClassificationTabs}
          >
            <strong>{dataset.classifiedCount}</strong>
            <span>classified</span>
          </button>
        </div>
        <label className="genre-admin-search">
          <span className="sr-only">Search artists</span>
          <Search size={16} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => searchArtists(event.target.value)}
            placeholder="Search artists"
          />
        </label>
        <div className="genre-admin-confidence-controls">
          <label>
            <span>Evidence confidence</span>
            <select
              value={confidenceFilter}
              onChange={(event) => selectConfidence(event.target.value as ConfidenceFilter)}
            >
              <option value="all">All suggestions</option>
              <option value="high">High ({dataset.confidenceCounts.high})</option>
              <option value="medium">Medium ({dataset.confidenceCounts.medium})</option>
              <option value="low">Low ({dataset.confidenceCounts.low})</option>
            </select>
          </label>
          {classificationFilter === "unclassified" && dataset.eligibleHighCount > 0 && (
            <button type="button" disabled={bulkSaving} onClick={() => void bulkConfirmHigh()}>
              {bulkSaving
                ? "Confirming..."
                : `Confirm eligible HIGH (${dataset.eligibleHighCount})`}
            </button>
          )}
        </div>
        <p className="genre-admin-result-count" aria-live="polite">
          {filteredArtists.length} artists
        </p>
        <div
          className="genre-admin-artist-list"
          id="genre-review-artist-list"
          role="tabpanel"
          aria-labelledby={`genre-review-${classificationFilter}-tab`}
        >
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
                  ? `${artist.genreSlugs.length} confirmed · ${artist.confirmationOrigin}`
                  : artist.skipped
                    ? "Skipped"
                    : `${artist.suggestion?.confidence ?? "low"} · Needs review`}
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
                {selectedArtist.genreSlugs.length > 0
                  ? `${selectedArtist.confirmationOrigin} confirmation`
                  : "Unclassified"}
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
                    Evidence stays private. Only strict eligible HIGH suggestions can be bulk
                    confirmed.
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
                  {(selectedArtist.suggestion.conflicts?.length ?? 0) > 0 && (
                    <div className="genre-conflict-list" role="alert">
                      <p>Evidence conflicts</p>
                      <ul>
                        {selectedArtist.suggestion.conflicts?.map((conflict) => (
                          <li key={conflict.summary}>{conflict.summary}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {selectedArtist.suggestion.sources.length > 0 && (
                    <ul className="genre-source-list">
                      {selectedArtist.suggestion.sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.title}
                          </a>
                          <span>
                            {source.kind?.replaceAll("-", " ") ?? "public source"}
                            {source.evidenceCount === undefined
                              ? ""
                              : ` · ${source.evidenceCount} evidence ${source.evidenceCount === 1 ? "item" : "items"}`}
                          </span>
                          {(source.terms?.length ?? 0) > 0 && (
                            <small>Terms: {source.terms?.join(", ")}</small>
                          )}
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
              <div>
                {selectedArtist.genreSlugs.length === 0 && (
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={saveState === "saving"}
                    onClick={() => void skipAndNext()}
                  >
                    Skip & Next
                  </button>
                )}
                <button
                  type="button"
                  className="button button-primary"
                  disabled={saveState === "saving"}
                  onClick={() => void saveAndNext()}
                >
                  {saveState === "saving" ? "Saving..." : "Save & Next"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
