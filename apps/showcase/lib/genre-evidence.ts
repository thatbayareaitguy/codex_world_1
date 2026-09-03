import { z } from "zod";

import {
  artistGenreSuggestionSchema,
  type ArtistGenreSuggestion,
  type GenreEvidenceSourceKind,
} from "./genre-editorial-contract";
import {
  expandGenreParents,
  normalizeEvidenceTerm,
  showcaseGenreParents,
  showcaseGenreSlugs,
  type PublicGenreSlug,
} from "./genre-taxonomy";
import type { PublicArtist } from "./public-catalog";

const discogsResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      style: z.array(z.string()).optional(),
    }),
  ),
});

export const genreEvidenceRecordSchema = z.object({
  publicId: z.string().regex(/^artist_[a-z0-9]+$/),
  artistName: z.string().trim().min(1).max(240),
  researchedAt: z.string().datetime(),
  suggestion: artistGenreSuggestionSchema,
});

export const genreEvidenceDocumentSchema = z.object({
  contractVersion: z.literal("showcase-private-genre-evidence-v1"),
  updatedAt: z.string().datetime().nullable(),
  records: z.record(z.string(), genreEvidenceRecordSchema),
});

export type GenreEvidenceRecord = z.infer<typeof genreEvidenceRecordSchema>;
export type GenreEvidenceDocument = z.infer<typeof genreEvidenceDocumentSchema>;

const strongSourceKinds = new Set<GenreEvidenceSourceKind>([
  "official-artist",
  "official-label",
  "allmusic",
]);

function normalizeComparableArtistName(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/\s*\(\d+\)\s*$/g, "")
    .replaceAll("&", "and")
    .replaceAll(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function specificGenres(values: readonly PublicGenreSlug[]): PublicGenreSlug[] {
  const set = new Set(values);
  return values.filter(
    (candidate) =>
      !values.some(
        (other) => other !== candidate && (showcaseGenreParents[other] ?? []).includes(candidate),
      ) || !set.has(candidate),
  );
}

function sourceKind(source: ArtistGenreSuggestion["sources"][number]): GenreEvidenceSourceKind {
  if (source.kind !== undefined) return source.kind;
  const title = source.title.toLowerCase();
  if (title.includes("allmusic")) return "allmusic";
  if (title.includes("official")) return "official-artist";
  if (title.includes("label") || title.includes("records")) return "official-label";
  return "editorial-knowledge";
}

function buildDiscogsSuggestion(
  artist: PublicArtist,
  results: z.infer<typeof discogsResponseSchema>["results"],
): ArtistGenreSuggestion {
  const expectedArtist = normalizeComparableArtistName(artist.name);
  const exactResults = results.filter((result) => {
    const separator = result.title.indexOf(" - ");
    if (separator < 1) return false;
    return normalizeComparableArtistName(result.title.slice(0, separator)) === expectedArtist;
  });
  const styleCounts = new Map<string, number>();
  for (const result of exactResults) {
    for (const style of new Set(result.style ?? [])) {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
  }
  const recognized = [...styleCounts.entries()]
    .map(([term, count]) => ({ term, count, genreSlugs: normalizeEvidenceTerm(term) }))
    .filter((entry) => entry.genreSlugs.length > 0)
    .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term));
  const minimumCount = exactResults.length >= 3 ? 2 : 1;
  const selectedEntries = recognized.filter(
    (entry) =>
      entry.count >= minimumCount && entry.count / Math.max(exactResults.length, 1) >= 0.34,
  );
  const selectedGenres = expandGenreParents(selectedEntries.flatMap((entry) => entry.genreSlugs));
  const searchUrl = `https://www.discogs.com/search/?type=release&artist=${encodeURIComponent(artist.name)}`;

  if (selectedGenres.length === 0) {
    return {
      genreSlugs: ["other-electronic"],
      confidence: "low",
      evidenceSummary:
        exactResults.length === 0
          ? "Discogs returned no exact artist release matches. No classification is recommended."
          : `Discogs returned ${exactResults.length} exact artist release ${exactResults.length === 1 ? "match" : "matches"}, but the style evidence was too sparse or outside the Showcase taxonomy.`,
      sources: [
        {
          title: "Discogs release search",
          url: searchUrl,
          kind: "discogs",
          terms: [...styleCounts.keys()].slice(0, 30),
          normalizedGenreSlugs: [],
          evidenceCount: Math.max(exactResults.length, 1),
        },
      ],
      conflicts: [],
      automationEligible: false,
      researchStatus: exactResults.length === 0 ? "not-found" : "partial",
    };
  }

  return {
    genreSlugs: selectedGenres,
    confidence: exactResults.length >= 3 ? "medium" : "low",
    evidenceSummary: `Discogs shows ${exactResults.length} exact artist release ${exactResults.length === 1 ? "match" : "matches"}. Repeated styles include ${selectedEntries
      .slice(0, 5)
      .map((entry) => `${entry.term} (${entry.count})`)
      .join(", ")}.`,
    sources: [
      {
        title: "Discogs release styles",
        url: searchUrl,
        kind: "discogs",
        terms: recognized.slice(0, 20).map((entry) => entry.term),
        normalizedGenreSlugs: selectedGenres,
        evidenceCount: exactResults.length,
      },
    ],
    conflicts: [],
    automationEligible: false,
    researchStatus: "researched",
  };
}

export async function researchDiscogsGenres(
  artist: PublicArtist,
  fetcher: typeof fetch = fetch,
): Promise<ArtistGenreSuggestion> {
  const url = new URL("https://api.discogs.com/database/search");
  url.searchParams.set("type", "release");
  url.searchParams.set("artist", artist.name);
  url.searchParams.set("per_page", "50");
  url.searchParams.set("page", "1");
  const response = await fetcher(url, {
    headers: { "user-agent": "ShowcaseGenreResearch/0.1 (showcasedmhq@gmail.com)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Discogs genre research failed with HTTP ${response.status}.`);
  const parsed = discogsResponseSchema.parse(await response.json());
  return buildDiscogsSuggestion(artist, parsed.results);
}

export function combineGenreEvidence(
  curated: ArtistGenreSuggestion | undefined,
  discogs: ArtistGenreSuggestion,
): ArtistGenreSuggestion {
  if (curated === undefined) return discogs;

  const curatedGenres = specificGenres(curated.genreSlugs);
  const discogsGenres = specificGenres(discogs.genreSlugs).filter(
    (slug) => slug !== "other-electronic",
  );
  const discogsGenreSet = new Set<PublicGenreSlug>(discogsGenres);
  const overlap = curatedGenres.filter(
    (slug) => slug !== "other-electronic" && discogsGenreSet.has(slug),
  );
  const hasDiscogsEvidence = discogs.researchStatus === "researched";
  const conflicts =
    hasDiscogsEvidence && overlap.length === 0 && discogsGenres.length > 0
      ? [
          {
            summary: `Curated evidence suggests ${curatedGenres.join(", ")}, while Discogs release styles suggest ${discogsGenres.join(", ")}. Editorial review is required.`,
            sourceTitles: [
              ...curated.sources.map((source) => source.title),
              "Discogs release styles",
            ],
          },
        ]
      : [];
  const hasStrongSource = curated.sources.some((source) =>
    strongSourceKinds.has(sourceKind(source)),
  );
  const independentKinds = new Set([
    ...curated.sources.map(sourceKind),
    ...discogs.sources.map(sourceKind),
  ]);
  const automationEligible =
    hasStrongSource &&
    independentKinds.size >= 2 &&
    overlap.length > 0 &&
    conflicts.length === 0 &&
    !curated.genreSlugs.includes("other-electronic");

  return {
    genreSlugs: expandGenreParents(curated.genreSlugs),
    confidence: automationEligible ? "high" : "medium",
    evidenceSummary: automationEligible
      ? `${curated.evidenceSummary} Discogs release styles independently corroborate ${overlap.join(", ")}.`
      : conflicts.length > 0
        ? `${curated.evidenceSummary} Discogs evidence conflicts with the curated classification, so no automatic confirmation is allowed.`
        : `${curated.evidenceSummary} A second independent source did not clearly corroborate the classification, so editorial confirmation remains required.`,
    sources: [...curated.sources, ...discogs.sources].slice(0, 5),
    conflicts,
    automationEligible,
    researchStatus: hasDiscogsEvidence ? "researched" : "partial",
  };
}

export function emptyGenreEvidenceDocument(): GenreEvidenceDocument {
  return {
    contractVersion: "showcase-private-genre-evidence-v1",
    updatedAt: null,
    records: {},
  };
}

export function validateEvidenceGenreSlugs(values: readonly string[]): PublicGenreSlug[] {
  return expandGenreParents(
    values.filter((value): value is PublicGenreSlug =>
      showcaseGenreSlugs.includes(value as PublicGenreSlug),
    ),
  );
}
