import { z } from "zod";

import { showcaseGenreSlugs } from "./genre-taxonomy";

export const genreSuggestionConfidenceSchema = z.enum(["high", "medium", "low"]);

export const genreEvidenceSourceKindSchema = z.enum([
  "official-artist",
  "official-label",
  "allmusic",
  "discogs",
  "lastfm",
  "musicbrainz",
  "beatport",
  "bandcamp",
  "editorial-knowledge",
  "label-association",
  "collaborator",
]);

export const genreSuggestionSourceSchema = z.object({
  title: z.string().trim().min(1).max(160),
  url: z.url().max(500),
  kind: genreEvidenceSourceKindSchema.optional(),
  terms: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  normalizedGenreSlugs: z
    .array(z.enum(showcaseGenreSlugs))
    .max(showcaseGenreSlugs.length)
    .optional(),
  evidenceCount: z.number().int().positive().max(10_000).optional(),
});

export const genreEvidenceConflictSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  sourceTitles: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
});

export const artistGenreSuggestionSchema = z.object({
  genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
  confidence: genreSuggestionConfidenceSchema,
  evidenceSummary: z.string().trim().min(1).max(800),
  sources: z.array(genreSuggestionSourceSchema).max(5),
  conflicts: z.array(genreEvidenceConflictSchema).max(8).optional(),
  automationEligible: z.boolean().optional(),
  researchStatus: z.enum(["researched", "partial", "not-found", "legacy"]).optional(),
});

export const saveArtistGenreReviewSchema = z.object({
  publicId: z.string().regex(/^artist_[a-z0-9]+$/),
  genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
});

export const genreReviewMutationSchema = z.union([
  saveArtistGenreReviewSchema.extend({ action: z.literal("save").optional() }),
  z.object({ action: z.literal("skip"), publicId: z.string().regex(/^artist_[a-z0-9]+$/) }),
  z.object({ action: z.literal("bulk-confirm-high") }),
]);

export type GenreSuggestionConfidence = z.infer<typeof genreSuggestionConfidenceSchema>;
export type GenreEvidenceSourceKind = z.infer<typeof genreEvidenceSourceKindSchema>;
export type ArtistGenreSuggestion = z.infer<typeof artistGenreSuggestionSchema>;
export type SaveArtistGenreReview = z.infer<typeof saveArtistGenreReviewSchema>;
export type GenreReviewMutation = z.infer<typeof genreReviewMutationSchema>;
export type GenreConfirmationOrigin = "manual" | "automated" | "catalog";

export interface GenreReviewArtist {
  readonly publicId: string;
  readonly slug: string;
  readonly name: string;
  readonly labelAssociations: readonly string[];
  readonly genreSlugs: readonly string[];
  readonly suggestion?: ArtistGenreSuggestion;
  readonly confirmationOrigin: GenreConfirmationOrigin;
  readonly skipped: boolean;
}

export interface GenreReviewDataset {
  readonly taxonomy: readonly { readonly name: string; readonly slug: string }[];
  readonly artists: readonly GenreReviewArtist[];
  readonly classifiedCount: number;
  readonly unclassifiedCount: number;
  readonly eligibleHighCount: number;
  readonly confidenceCounts: Readonly<Record<GenreSuggestionConfidence, number>>;
}
