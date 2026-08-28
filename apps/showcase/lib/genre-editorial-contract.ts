import { z } from "zod";

import { showcaseGenreSlugs } from "./genre-taxonomy";

export const genreSuggestionConfidenceSchema = z.enum(["high", "medium", "low"]);

export const genreSuggestionSourceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: z.url().max(500),
});

export const artistGenreSuggestionSchema = z.object({
  genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
  confidence: genreSuggestionConfidenceSchema,
  evidenceSummary: z.string().trim().min(1).max(800),
  sources: z.array(genreSuggestionSourceSchema).max(5),
});

export const saveArtistGenreReviewSchema = z.object({
  publicId: z.string().regex(/^artist_[a-z0-9]+$/),
  genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
});

export type GenreSuggestionConfidence = z.infer<typeof genreSuggestionConfidenceSchema>;
export type ArtistGenreSuggestion = z.infer<typeof artistGenreSuggestionSchema>;
export type SaveArtistGenreReview = z.infer<typeof saveArtistGenreReviewSchema>;

export interface GenreReviewArtist {
  readonly publicId: string;
  readonly slug: string;
  readonly name: string;
  readonly labelAssociations: readonly string[];
  readonly genreSlugs: readonly string[];
  readonly suggestion?: ArtistGenreSuggestion;
}

export interface GenreReviewDataset {
  readonly taxonomy: readonly { readonly name: string; readonly slug: string }[];
  readonly artists: readonly GenreReviewArtist[];
  readonly classifiedCount: number;
  readonly unclassifiedCount: number;
}
