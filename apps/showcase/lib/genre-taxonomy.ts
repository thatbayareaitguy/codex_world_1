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

export const showcaseGenreParents: Readonly<
  Partial<Record<PublicGenreSlug, readonly PublicGenreSlug[]>>
> = {
  dubstep: ["bass-music"],
  riddim: ["dubstep", "bass-music"],
  "melodic-dubstep": ["dubstep", "bass-music"],
  "experimental-bass": ["bass-music"],
  "midtempo-bass": ["bass-music"],
  "bass-house": ["house"],
  "tech-house": ["house"],
  "progressive-house": ["house"],
  "electro-house": ["house"],
} as const;

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

const evidenceGenreMap: Readonly<Record<string, readonly PublicGenreSlug[]>> = {
  "bass house": ["bass-house"],
  "bass music": ["bass-music"],
  bassline: ["bass-music"],
  dnb: ["drum-and-bass"],
  "d&b": ["drum-and-bass"],
  "drum & bass": ["drum-and-bass"],
  "drum and bass": ["drum-and-bass"],
  "drum n bass": ["drum-and-bass"],
  drumandbass: ["drum-and-bass"],
  dubstep: ["dubstep"],
  "electro house": ["electro-house"],
  "electro-house": ["electro-house"],
  electronica: ["other-electronic"],
  electronic: ["other-electronic"],
  "experimental bass": ["experimental-bass"],
  "future bass": ["future-bass"],
  gabber: ["hard-dance"],
  hardcore: ["hard-dance"],
  "hard dance": ["hard-dance"],
  hardstyle: ["hard-dance"],
  house: ["house"],
  "leftfield bass": ["experimental-bass"],
  "melodic dubstep": ["melodic-dubstep"],
  "midtempo bass": ["midtempo-bass"],
  midtempo: ["midtempo-bass"],
  "progressive house": ["progressive-house"],
  riddim: ["riddim"],
  "riddim dubstep": ["riddim"],
  "tech house": ["tech-house"],
  techno: ["techno"],
  trance: ["trance"],
  trap: ["trap"],
};

export function isPublicGenreSlug(value: string): value is PublicGenreSlug {
  return genreOrder.has(value as PublicGenreSlug);
}

export function expandGenreParents(values: readonly PublicGenreSlug[]): PublicGenreSlug[] {
  const expanded = new Set<PublicGenreSlug>();
  const visit = (slug: PublicGenreSlug): void => {
    if (expanded.has(slug)) return;
    expanded.add(slug);
    for (const parent of showcaseGenreParents[slug] ?? []) visit(parent);
  };
  for (const value of values) visit(value);
  return [...expanded].sort(
    (left, right) => (genreOrder.get(left) ?? 999) - (genreOrder.get(right) ?? 999),
  );
}

export function normalizeEvidenceTerm(value: string): PublicGenreSlug[] {
  const normalized = value.trim().toLowerCase().replaceAll("_", " ").replaceAll(/\s+/g, " ");
  const direct = evidenceGenreMap[normalized];
  if (direct !== undefined) return expandGenreParents(direct);
  if (normalized.includes("riddim") && normalized.includes("dubstep")) {
    return expandGenreParents(["riddim"]);
  }
  return [];
}

export function normalizeGenreSlugs(values: readonly string[]): PublicGenreSlug[] {
  const normalized = [
    ...new Set(
      values.flatMap((value) => {
        const normalized = value.trim().toLowerCase();
        if (isPublicGenreSlug(normalized)) return [normalized];
        const migrated = legacyGenreMap[normalized];
        return migrated === undefined ? [] : [migrated];
      }),
    ),
  ].sort((left, right) => (genreOrder.get(left) ?? 999) - (genreOrder.get(right) ?? 999));
  return expandGenreParents(normalized);
}
