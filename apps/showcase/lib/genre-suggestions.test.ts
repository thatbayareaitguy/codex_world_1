import { describe, expect, it } from "vitest";

import { suggestArtistGenres } from "./genre-suggestions";
import { publicCatalog } from "./public-catalog";

describe("artist genre suggestions", () => {
  it("uses cited public research without publishing it", () => {
    const artist = publicCatalog.artists.find((candidate) => candidate.name === "CloZee");
    expect(artist).toBeDefined();
    const artistsBySlug = new Map(
      publicCatalog.artists.map((candidate) => [candidate.slug, candidate]),
    );
    const suggestion = suggestArtistGenres(artist!, publicCatalog.releases, artistsBySlug);
    expect(suggestion.genreSlugs).toEqual(["bass-music", "experimental-bass"]);
    expect(suggestion.confidence).toBe("high");
    expect(suggestion.sources[0]?.url).toBe("https://www.clozee.net/about");
    expect(artist?.genreSlugs).toEqual([]);
  });

  it("marks unsourced model knowledge as a medium-confidence editorial draft", () => {
    const artist = publicCatalog.artists.find((candidate) => candidate.name === "3LAU");
    expect(artist).toBeDefined();
    const artistsBySlug = new Map(
      publicCatalog.artists.map((candidate) => [candidate.slug, candidate]),
    );
    const suggestion = suggestArtistGenres(artist!, publicCatalog.releases, artistsBySlug);
    expect(suggestion.genreSlugs).toEqual(["future-bass", "progressive-house"]);
    expect(suggestion.confidence).toBe("medium");
    expect(suggestion.sources).toEqual([]);
  });
});
