import { showcaseGenreTaxonomy, type PublicGenreSlug } from "./genre-taxonomy";
import type { PublicArtist, PublicRelease } from "./public-catalog";

const genreNameBySlug = new Map(
  showcaseGenreTaxonomy.map((genre) => [genre.slug, genre.name] as const),
);

export const getGenreNames = (genreSlugs: readonly PublicGenreSlug[]): readonly string[] =>
  genreSlugs.flatMap((slug) => {
    const name = genreNameBySlug.get(slug);
    return name === undefined ? [] : [name];
  });

export const getArtistGenreNames = (artist: PublicArtist): readonly string[] =>
  getGenreNames(artist.genreSlugs);

export const getReleaseGenreNames = (release: PublicRelease): readonly string[] =>
  getGenreNames(release.genreSlugs);

export const formatArtistCredits = (release: PublicRelease): string =>
  release.artistCredits.map((credit) => credit.name).join(" & ");

export const formatPublicDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
