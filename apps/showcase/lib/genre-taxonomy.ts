export const showcaseGenreSlugs = [
  "bass-music",
  "dubstep",
  "riddim",
  "melodic-dubstep",
  "experimental-bass",
  "midtempo-bass",
  "trap",
  "future-bass",
  "drum-and-bass",
  "house",
  "bass-house",
  "tech-house",
  "progressive-house",
  "electro-house",
  "trance",
  "techno",
  "hard-dance",
  "other-electronic",
] as const;

export type PublicGenreSlug = (typeof showcaseGenreSlugs)[number];

export const showcaseGenreTaxonomy: readonly {
  readonly name: string;
  readonly slug: PublicGenreSlug;
}[] = [
  { name: "Bass Music", slug: "bass-music" },
  { name: "Dubstep", slug: "dubstep" },
  { name: "Riddim", slug: "riddim" },
  { name: "Melodic Dubstep", slug: "melodic-dubstep" },
  { name: "Experimental Bass", slug: "experimental-bass" },
  { name: "Midtempo Bass", slug: "midtempo-bass" },
  { name: "Trap", slug: "trap" },
  { name: "Future Bass", slug: "future-bass" },
  { name: "Drum & Bass", slug: "drum-and-bass" },
  { name: "House", slug: "house" },
  { name: "Bass House", slug: "bass-house" },
  { name: "Tech House", slug: "tech-house" },
  { name: "Progressive House", slug: "progressive-house" },
  { name: "Electro House", slug: "electro-house" },
  { name: "Trance", slug: "trance" },
  { name: "Techno", slug: "techno" },
  { name: "Hard Dance", slug: "hard-dance" },
  { name: "Other Electronic", slug: "other-electronic" },
] as const;

const genreOrder = new Map(showcaseGenreSlugs.map((slug, index) => [slug, index] as const));

const legacyGenreMap: Readonly<Record<string, PublicGenreSlug>> = {
  ambient: "other-electronic",
  bass: "bass-music",
  "bass-music": "bass-music",
  breaks: "bass-music",
  dance: "other-electronic",
  downtempo: "other-electronic",
  "drum-and-bass": "drum-and-bass",
  dubstep: "dubstep",
  electronic: "other-electronic",
  electronica: "other-electronic",
  experimental: "other-electronic",
  garage: "bass-music",
  hardcore: "hard-dance",
  house: "house",
  industrial: "other-electronic",
  techno: "techno",
  trance: "trance",
  trap: "trap",
};

export function isPublicGenreSlug(value: string): value is PublicGenreSlug {
  return genreOrder.has(value as PublicGenreSlug);
}

export function normalizeGenreSlugs(values: readonly string[]): PublicGenreSlug[] {
  return [
    ...new Set(
      values.flatMap((value) => {
        const normalized = value.trim().toLowerCase();
        if (isPublicGenreSlug(normalized)) return [normalized];
        const migrated = legacyGenreMap[normalized];
        return migrated === undefined ? [] : [migrated];
      }),
    ),
  ].sort((left, right) => (genreOrder.get(left) ?? 999) - (genreOrder.get(right) ?? 999));
}
