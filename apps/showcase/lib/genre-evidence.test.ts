import { describe, expect, it, vi } from "vitest";

import { combineGenreEvidence, researchDiscogsGenres } from "./genre-evidence";
import { getCuratedGenreSuggestion } from "./genre-suggestions";
import { publicCatalog } from "./public-catalog";

function artist(name: string) {
  const result = publicCatalog.artists.find((candidate) => candidate.name === name);
  expect(result).toBeDefined();
  return result!;
}

describe("genre evidence research", () => {
  it("normalizes repeated exact Discogs release styles without treating one source as HIGH", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            { title: "Camo & Krooked - One", style: ["Drum n Bass"] },
            { title: "Camo & Krooked - Two", style: ["Drum n Bass"] },
            { title: "Camo & Krooked - Three", style: ["Drum n Bass"] },
            { title: "Different Artist - Noise", style: ["Techno"] },
          ],
        }),
        { status: 200 },
      ),
    );
    const suggestion = await researchDiscogsGenres(artist("Camo & Krooked"), fetcher);
    expect(suggestion.genreSlugs).toEqual(["drum-and-bass"]);
    expect(suggestion.confidence).toBe("medium");
    expect(suggestion.automationEligible).toBe(false);
    expect(suggestion.sources[0]).toMatchObject({ kind: "discogs", evidenceCount: 3 });
  });

  it("allows HIGH automation only for strong independent corroboration", () => {
    const target = artist("Camo & Krooked");
    const curated = getCuratedGenreSuggestion(target);
    expect(curated).toBeDefined();
    const discogs = {
      genreSlugs: ["drum-and-bass" as const],
      confidence: "medium" as const,
      evidenceSummary: "Three Discogs releases agree.",
      sources: [
        {
          title: "Discogs release styles",
          url: "https://www.discogs.com/search/?type=release&artist=Camo%20%26%20Krooked",
          kind: "discogs" as const,
          evidenceCount: 3,
        },
      ],
      conflicts: [],
      automationEligible: false,
      researchStatus: "researched" as const,
    };
    const combined = combineGenreEvidence(curated, discogs);
    expect(combined.confidence).toBe("high");
    expect(combined.automationEligible).toBe(true);
    expect(combined.conflicts).toEqual([]);
  });

  it("blocks automation when reputable sources conflict", () => {
    const target = artist("Camo & Krooked");
    const curated = getCuratedGenreSuggestion(target);
    const conflicting = {
      genreSlugs: ["house" as const, "tech-house" as const],
      confidence: "medium" as const,
      evidenceSummary: "Discogs styles differ.",
      sources: [
        {
          title: "Discogs release styles",
          url: "https://www.discogs.com/search/",
          kind: "discogs" as const,
          evidenceCount: 4,
        },
      ],
      conflicts: [],
      automationEligible: false,
      researchStatus: "researched" as const,
    };
    const combined = combineGenreEvidence(curated, conflicting);
    expect(combined.confidence).toBe("medium");
    expect(combined.automationEligible).toBe(false);
    expect(combined.conflicts).toHaveLength(1);
  });
});
