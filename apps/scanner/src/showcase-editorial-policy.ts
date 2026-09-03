import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  showcaseGenreSlugs,
  showcasePublicCatalogSchema,
  type ShowcaseGenreSlug,
  type ShowcasePublicCatalog,
} from "./showcase-publication";

const confirmedGenresSchema = z
  .object({
    contractVersion: z.literal("showcase-confirmed-artist-genres-v1"),
    updatedAt: z.iso.datetime({ offset: true }),
    assignments: z.array(
      z
        .object({
          publicId: z.string().regex(/^artist_[a-f0-9]{20}$/u),
          genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
        })
        .strict(),
    ),
  })
  .strict();

const excludedArtistsSchema = z
  .object({
    contractVersion: z.literal("showcase-excluded-public-artists-v1"),
    updatedAt: z.iso.datetime({ offset: true }),
    artistPublicIds: z.array(z.string().regex(/^artist_[a-f0-9]{20}$/u)),
  })
  .strict();

const genreParents: Readonly<Partial<Record<ShowcaseGenreSlug, readonly ShowcaseGenreSlug[]>>> = {
  dubstep: ["bass-music"],
  riddim: ["dubstep", "bass-music"],
  "melodic-dubstep": ["dubstep", "bass-music"],
  "experimental-bass": ["bass-music"],
  "midtempo-bass": ["bass-music"],
  "bass-house": ["house"],
  "tech-house": ["house"],
  "progressive-house": ["house"],
  "electro-house": ["house"],
};

const genreOrder = new Map(showcaseGenreSlugs.map((slug, index) => [slug, index] as const));

function normalizeGenreSlugs(values: readonly ShowcaseGenreSlug[]): ShowcaseGenreSlug[] {
  const normalized = new Set<ShowcaseGenreSlug>();
  const visit = (slug: ShowcaseGenreSlug): void => {
    if (normalized.has(slug)) return;
    normalized.add(slug);
    for (const parent of genreParents[slug] ?? []) visit(parent);
  };
  for (const value of values) visit(value);
  return [...normalized].sort(
    (left, right) =>
      (genreOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (genreOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

export async function applyShowcaseEditorialPolicy(
  catalog: ShowcasePublicCatalog,
  paths: { readonly confirmedGenres: string; readonly excludedArtists: string },
): Promise<ShowcasePublicCatalog> {
  const [confirmedSource, excludedSource] = await Promise.all([
    readFile(paths.confirmedGenres, "utf8"),
    readFile(paths.excludedArtists, "utf8"),
  ]);
  const confirmed = confirmedGenresSchema.parse(JSON.parse(confirmedSource) as unknown);
  const excluded = excludedArtistsSchema.parse(JSON.parse(excludedSource) as unknown);
  const confirmedByArtistId = new Map(
    confirmed.assignments.map((assignment) => [
      assignment.publicId,
      normalizeGenreSlugs(assignment.genreSlugs),
    ]),
  );
  const excludedIds = new Set(excluded.artistPublicIds);
  const excludedSlugs = new Set(
    catalog.artists.flatMap((artist) => (excludedIds.has(artist.publicId) ? [artist.slug] : [])),
  );
  const artists = catalog.artists
    .filter((artist) => !excludedIds.has(artist.publicId))
    .map((artist) => ({
      ...artist,
      genreSlugs: normalizeGenreSlugs(
        confirmedByArtistId.get(artist.publicId) ?? artist.genreSlugs,
      ),
    }));
  const artistBySlug = new Map(artists.map((artist) => [artist.slug, artist]));
  const releases = catalog.releases
    .filter(
      (release) =>
        !release.artistCredits.some(
          (credit) => credit.artistSlug !== undefined && excludedSlugs.has(credit.artistSlug),
        ),
    )
    .map((release) => ({
      ...release,
      genreSlugs: normalizeGenreSlugs(
        release.artistCredits.flatMap((credit) =>
          credit.artistSlug === undefined
            ? []
            : (artistBySlug.get(credit.artistSlug)?.genreSlugs ?? []),
        ),
      ),
    }));

  return showcasePublicCatalogSchema.parse({ ...catalog, artists, releases });
}
