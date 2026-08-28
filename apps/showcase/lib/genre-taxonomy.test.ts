import { describe, expect, it } from "vitest";

import { normalizeGenreSlugs, showcaseGenreTaxonomy } from "./genre-taxonomy";

const expectedTaxonomy = [
  ["Bass Music", "bass-music"],
  ["Dubstep", "dubstep"],
  ["Riddim", "riddim"],
  ["Melodic Dubstep", "melodic-dubstep"],
  ["Experimental Bass", "experimental-bass"],
  ["Midtempo Bass", "midtempo-bass"],
  ["Trap", "trap"],
  ["Future Bass", "future-bass"],
  ["Drum & Bass", "drum-and-bass"],
  ["House", "house"],
  ["Bass House", "bass-house"],
  ["Tech House", "tech-house"],
  ["Progressive House", "progressive-house"],
  ["Electro House", "electro-house"],
  ["Trance", "trance"],
  ["Techno", "techno"],
  ["Hard Dance", "hard-dance"],
  ["Other Electronic", "other-electronic"],
];

describe("Showcase genre taxonomy", () => {
  it("uses the fixed editorial taxonomy in product order", () => {
    expect(showcaseGenreTaxonomy.map((genre) => [genre.name, genre.slug])).toEqual(
      expectedTaxonomy,
    );
  });

  it("preserves clean legacy assignments and safely migrates broad genres", () => {
    expect(normalizeGenreSlugs(["dubstep", "house", "bass", "hardcore", "electronic"])).toEqual([
      "bass-music",
      "dubstep",
      "house",
      "hard-dance",
      "other-electronic",
    ]);
  });
});
