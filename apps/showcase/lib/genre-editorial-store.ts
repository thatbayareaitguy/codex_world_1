import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  artistGenreSuggestionSchema,
  saveArtistGenreReviewSchema,
  type ArtistGenreSuggestion,
  type GenreReviewDataset,
  type SaveArtistGenreReview,
} from "./genre-editorial-contract";
import { getGenreEvidencePath, readGenreEvidenceDocument } from "./genre-evidence-store";
import { suggestArtistGenres } from "./genre-suggestions";
import { normalizeGenreSlugs, showcaseGenreTaxonomy, showcaseGenreSlugs } from "./genre-taxonomy";
import { publicCatalog, type PublicArtist } from "./public-catalog";

const confirmedGenresSchema = z.object({
  contractVersion: z.literal("showcase-confirmed-artist-genres-v1"),
  updatedAt: z.string().datetime().nullable(),
  assignments: z.array(
    z.object({
      publicId: z.string().regex(/^artist_[a-z0-9]+$/),
      genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
    }),
  ),
});

const privateReviewsSchema = z.object({
  contractVersion: z.literal("showcase-private-genre-reviews-v1"),
  updatedAt: z.string().datetime().nullable(),
  suggestions: z.record(z.string(), artistGenreSuggestionSchema),
  reviewedAtByArtistId: z.record(z.string(), z.string().datetime()),
  confirmationOrigins: z
    .record(
      z.string(),
      z.object({
        mode: z.enum(["manual", "automated"]),
        confirmedAt: z.string().datetime(),
        evidenceResearchedAt: z.string().datetime().optional(),
        evidenceSnapshot: artistGenreSuggestionSchema.optional(),
      }),
    )
    .default({}),
  skippedAtByArtistId: z.record(z.string(), z.string().datetime()).default({}),
});

type ConfirmedGenresDocument = z.infer<typeof confirmedGenresSchema>;
type PrivateReviewsDocument = z.infer<typeof privateReviewsSchema>;

export interface GenreEditorialStoreOptions {
  readonly confirmedGenresPath?: string;
  readonly privateReviewsPath?: string;
  readonly evidencePath?: string;
  readonly now?: () => Date;
}

export function getDefaultConfirmedGenresPath(): string {
  return (
    process.env.SHOWCASE_CONFIRMED_GENRES_PATH ??
    resolve(dirname(fileURLToPath(import.meta.url)), "confirmed-artist-genres.json")
  );
}

function getDefaultPrivateReviewsPath(): string {
  const localDataRoot = process.env.LOCALAPPDATA;
  if (localDataRoot === undefined || localDataRoot.trim() === "") {
    return resolve(process.cwd(), ".app-runtime", "artist-genre-reviews.json");
  }
  return (
    process.env.SHOWCASE_GENRE_REVIEW_PATH ??
    resolve(localDataRoot, "ShowcasePublicSite", "editorial", "artist-genre-reviews.json")
  );
}

async function readJsonOrDefault<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function emptyConfirmedDocument(): ConfirmedGenresDocument {
  return {
    contractVersion: "showcase-confirmed-artist-genres-v1",
    updatedAt: null,
    assignments: [],
  };
}

function emptyPrivateDocument(): PrivateReviewsDocument {
  return {
    contractVersion: "showcase-private-genre-reviews-v1",
    updatedAt: null,
    suggestions: {},
    reviewedAtByArtistId: {},
    confirmationOrigins: {},
    skippedAtByArtistId: {},
  };
}

function paths(options: GenreEditorialStoreOptions): {
  confirmedGenresPath: string;
  privateReviewsPath: string;
  evidencePath: string;
} {
  return {
    confirmedGenresPath: options.confirmedGenresPath ?? getDefaultConfirmedGenresPath(),
    privateReviewsPath: options.privateReviewsPath ?? getDefaultPrivateReviewsPath(),
    evidencePath: options.evidencePath ?? getGenreEvidencePath(),
  };
}

async function loadDocuments(options: GenreEditorialStoreOptions): Promise<{
  confirmed: ConfirmedGenresDocument;
  privateReviews: PrivateReviewsDocument;
}> {
  const resolved = paths(options);
  const [confirmed, privateReviews] = await Promise.all([
    readJsonOrDefault(
      resolved.confirmedGenresPath,
      confirmedGenresSchema,
      emptyConfirmedDocument(),
    ),
    readJsonOrDefault(resolved.privateReviewsPath, privateReviewsSchema, emptyPrivateDocument()),
  ]);
  return { confirmed, privateReviews };
}

function applyConfirmations(
  artists: readonly PublicArtist[],
  confirmed: ConfirmedGenresDocument,
): readonly PublicArtist[] {
  const assignments = new Map(
    confirmed.assignments.map((assignment) => [
      assignment.publicId,
      normalizeGenreSlugs(assignment.genreSlugs),
    ]),
  );
  return artists.map((artist) => ({
    ...artist,
    genreSlugs: assignments.get(artist.publicId) ?? artist.genreSlugs,
  }));
}

async function ensureSuggestions(
  artists: readonly PublicArtist[],
  privateReviews: PrivateReviewsDocument,
  options: GenreEditorialStoreOptions,
): Promise<PrivateReviewsDocument> {
  const artistsBySlug = new Map(artists.map((artist) => [artist.slug, artist]));
  const nextSuggestions: Record<string, ArtistGenreSuggestion> = {};
  let changed = false;

  for (const artist of artists) {
    if (artist.genreSlugs.length > 0) continue;
    const existing = privateReviews.suggestions[artist.publicId];
    nextSuggestions[artist.publicId] =
      existing ?? suggestArtistGenres(artist, publicCatalog.releases, artistsBySlug);
    if (existing === undefined) changed = true;
  }

  if (Object.keys(privateReviews.suggestions).length !== Object.keys(nextSuggestions).length) {
    changed = true;
  }
  if (!changed) return privateReviews;

  const updated: PrivateReviewsDocument = {
    ...privateReviews,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    suggestions: nextSuggestions,
  };
  await writeJsonAtomically(paths(options).privateReviewsPath, updated);
  return updated;
}

export async function getGenreReviewDataset(
  options: GenreEditorialStoreOptions = {},
): Promise<GenreReviewDataset> {
  const { confirmed, privateReviews } = await loadDocuments(options);
  const evidence = await readGenreEvidenceDocument(paths(options).evidencePath);
  const artists = applyConfirmations(publicCatalog.artists, confirmed);
  const reviewsWithSuggestions = await ensureSuggestions(artists, privateReviews, options);
  const editorialArtists = artists
    .map((artist) => {
      const evidenceSuggestion = evidence.records[artist.publicId]?.suggestion;
      const confirmationRecord = reviewsWithSuggestions.confirmationOrigins[artist.publicId];
      const suggestion =
        evidenceSuggestion ??
        confirmationRecord?.evidenceSnapshot ??
        (artist.genreSlugs.length === 0
          ? reviewsWithSuggestions.suggestions[artist.publicId]
          : undefined);
      const storedOrigin = reviewsWithSuggestions.confirmationOrigins[artist.publicId]?.mode;
      const hasConfirmedAssignment = confirmed.assignments.some(
        (assignment) => assignment.publicId === artist.publicId,
      );
      return {
        publicId: artist.publicId,
        slug: artist.slug,
        name: artist.name,
        labelAssociations: artist.labelAssociations ?? [],
        genreSlugs: artist.genreSlugs,
        ...(suggestion === undefined ? {} : { suggestion }),
        confirmationOrigin:
          storedOrigin ?? (hasConfirmedAssignment ? "manual" : ("catalog" as const)),
        skipped: reviewsWithSuggestions.skippedAtByArtistId[artist.publicId] !== undefined,
      };
    })
    .sort((left, right) => {
      const classificationDifference =
        Number(left.genreSlugs.length > 0) - Number(right.genreSlugs.length > 0);
      return classificationDifference !== 0
        ? classificationDifference
        : left.name.localeCompare(right.name);
    });
  const classifiedCount = editorialArtists.filter((artist) => artist.genreSlugs.length > 0).length;
  const confidenceCounts = { high: 0, medium: 0, low: 0 };
  let eligibleHighCount = 0;
  for (const artist of editorialArtists) {
    if (artist.genreSlugs.length > 0 || artist.suggestion === undefined) continue;
    confidenceCounts[artist.suggestion.confidence] += 1;
    if (artist.suggestion.automationEligible === true) eligibleHighCount += 1;
  }
  return {
    taxonomy: showcaseGenreTaxonomy,
    artists: editorialArtists,
    classifiedCount,
    unclassifiedCount: editorialArtists.length - classifiedCount,
    eligibleHighCount,
    confidenceCounts,
  };
}

export async function saveArtistGenreReview(
  input: SaveArtistGenreReview,
  options: GenreEditorialStoreOptions = {},
): Promise<GenreReviewDataset> {
  const parsed = saveArtistGenreReviewSchema.parse(input);
  if (!publicCatalog.artists.some((artist) => artist.publicId === parsed.publicId)) {
    throw new Error("Unknown Showcase artist.");
  }

  const resolved = paths(options);
  const { confirmed, privateReviews } = await loadDocuments(options);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const nextAssignment = {
    publicId: parsed.publicId,
    genreSlugs: normalizeGenreSlugs(parsed.genreSlugs),
  };
  const nextConfirmed: ConfirmedGenresDocument = {
    ...confirmed,
    updatedAt: timestamp,
    assignments: [
      ...confirmed.assignments.filter((assignment) => assignment.publicId !== parsed.publicId),
      nextAssignment,
    ].sort((left, right) => left.publicId.localeCompare(right.publicId)),
  };
  const nextPrivate: PrivateReviewsDocument = {
    ...privateReviews,
    updatedAt: timestamp,
    reviewedAtByArtistId: {
      ...privateReviews.reviewedAtByArtistId,
      [parsed.publicId]: timestamp,
    },
    confirmationOrigins: {
      ...privateReviews.confirmationOrigins,
      [parsed.publicId]: { mode: "manual", confirmedAt: timestamp },
    },
    skippedAtByArtistId: Object.fromEntries(
      Object.entries(privateReviews.skippedAtByArtistId).filter(
        ([publicId]) => publicId !== parsed.publicId,
      ),
    ),
  };
  await Promise.all([
    writeJsonAtomically(resolved.confirmedGenresPath, nextConfirmed),
    writeJsonAtomically(resolved.privateReviewsPath, nextPrivate),
  ]);
  return getGenreReviewDataset(options);
}

export async function skipArtistGenreReview(
  publicId: string,
  options: GenreEditorialStoreOptions = {},
): Promise<GenreReviewDataset> {
  if (!/^artist_[a-z0-9]+$/.test(publicId)) throw new Error("Invalid Showcase artist ID.");
  if (!publicCatalog.artists.some((artist) => artist.publicId === publicId)) {
    throw new Error("Unknown Showcase artist.");
  }
  const resolved = paths(options);
  const { privateReviews } = await loadDocuments(options);
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  await writeJsonAtomically(resolved.privateReviewsPath, {
    ...privateReviews,
    updatedAt: timestamp,
    skippedAtByArtistId: {
      ...privateReviews.skippedAtByArtistId,
      [publicId]: timestamp,
    },
  } satisfies PrivateReviewsDocument);
  return getGenreReviewDataset(options);
}

export async function autoConfirmEligibleHighGenres(
  options: GenreEditorialStoreOptions = {},
): Promise<GenreReviewDataset> {
  const resolved = paths(options);
  const [{ confirmed, privateReviews }, evidence] = await Promise.all([
    loadDocuments(options),
    readGenreEvidenceDocument(resolved.evidencePath),
  ]);
  const currentlyAssigned = new Map<string, readonly string[]>(
    applyConfirmations(publicCatalog.artists, confirmed).map((artist) => [
      artist.publicId,
      artist.genreSlugs,
    ]),
  );
  const manuallyDecidedIds = new Set(
    confirmed.assignments.flatMap((assignment) =>
      privateReviews.confirmationOrigins[assignment.publicId]?.mode === "automated"
        ? []
        : [assignment.publicId],
    ),
  );
  const candidates = Object.values(evidence.records).filter(
    (record) =>
      record.suggestion.confidence === "high" &&
      record.suggestion.automationEligible === true &&
      !manuallyDecidedIds.has(record.publicId) &&
      privateReviews.skippedAtByArtistId[record.publicId] === undefined &&
      (currentlyAssigned.get(record.publicId)?.length ?? 0) === 0,
  );
  if (candidates.length === 0) return getGenreReviewDataset(options);

  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const candidateIds = new Set(candidates.map((candidate) => candidate.publicId));
  const nextConfirmed: ConfirmedGenresDocument = {
    ...confirmed,
    updatedAt: timestamp,
    assignments: [
      ...confirmed.assignments.filter((assignment) => !candidateIds.has(assignment.publicId)),
      ...candidates.map((candidate) => ({
        publicId: candidate.publicId,
        genreSlugs: normalizeGenreSlugs(candidate.suggestion.genreSlugs),
      })),
    ].sort((left, right) => left.publicId.localeCompare(right.publicId)),
  };
  const nextOrigins = { ...privateReviews.confirmationOrigins };
  for (const candidate of candidates) {
    nextOrigins[candidate.publicId] = {
      mode: "automated",
      confirmedAt: timestamp,
      evidenceResearchedAt: candidate.researchedAt,
      evidenceSnapshot: candidate.suggestion,
    };
  }
  const nextPrivate: PrivateReviewsDocument = {
    ...privateReviews,
    updatedAt: timestamp,
    confirmationOrigins: nextOrigins,
  };
  await Promise.all([
    writeJsonAtomically(resolved.confirmedGenresPath, nextConfirmed),
    writeJsonAtomically(resolved.privateReviewsPath, nextPrivate),
  ]);
  return getGenreReviewDataset(options);
}
