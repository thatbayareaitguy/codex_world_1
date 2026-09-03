import type { PublicArtist, PublicRelease } from "./public-catalog";
import type { ArtistGenreSuggestion } from "./genre-editorial-contract";
import { normalizeGenreSlugs, type PublicGenreSlug } from "./genre-taxonomy";

type Seed = ArtistGenreSuggestion;

const sourcedSeeds: Readonly<Record<string, Seed>> = {
  "ac-slater": {
    genreSlugs: ["bass-house"],
    confidence: "high",
    evidenceSummary: "Monstercat describes AC Slater as a pioneer of the bass house sound.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/ac-slater" },
    ],
  },
  afinity: {
    genreSlugs: ["future-bass", "melodic-dubstep"],
    confidence: "high",
    evidenceSummary: "Monstercat identifies Afinity with future bass and melodic dubstep.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/afinity" },
    ],
  },
  bijou: {
    genreSlugs: ["bass-house", "tech-house"],
    confidence: "high",
    evidenceSummary: "Monstercat describes BIJOU's sound as spanning bass house and tech house.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/bijou-1" },
    ],
  },
  "bleu-clair": {
    genreSlugs: ["tech-house", "bass-house"],
    confidence: "high",
    evidenceSummary: "Monstercat describes Bleu Clair through tech house and bass house.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/bleu-clair" },
    ],
  },
  "camo-krooked": {
    genreSlugs: ["drum-and-bass"],
    confidence: "high",
    evidenceSummary: "AllMusic identifies Camo & Krooked as an Austrian drum and bass duo.",
    sources: [
      {
        title: "AllMusic artist profile",
        url: "https://www.allmusic.com/artist/camo-krooked-mn0002106660",
      },
    ],
  },
  chyl: {
    genreSlugs: ["bass-house", "hard-dance"],
    confidence: "medium",
    evidenceSummary:
      "Monstercat describes CHYL through bass house and speed-house material; Hard Dance is the closest Showcase category for the latter.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/chyl" },
    ],
  },
  clozee: {
    genreSlugs: ["bass-music", "experimental-bass"],
    confidence: "high",
    evidenceSummary:
      "CloZee's official biography places her work in bass music and describes a genre-bending approach.",
    sources: [{ title: "CloZee official biography", url: "https://www.clozee.net/about" }],
  },
  "flatland-funk": {
    genreSlugs: ["dubstep", "trap", "bass-house"],
    confidence: "high",
    evidenceSummary: "Monstercat identifies Flatland Funk with dubstep, trap, and bass house.",
    sources: [
      {
        title: "Monstercat artist profile",
        url: "https://www.monstercat.com/artist/flatland-funk",
      },
    ],
  },
  longstoryshort: {
    genreSlugs: ["bass-house", "bass-music"],
    confidence: "medium",
    evidenceSummary:
      "Monstercat describes longstoryshort through UK garage, future garage, and bass house. Bass Music covers the garage side of the fixed taxonomy.",
    sources: [
      {
        title: "Monstercat artist profile",
        url: "https://www.monstercat.com/artist/longstoryshort",
      },
    ],
  },
  "neon-steve": {
    genreSlugs: ["bass-house"],
    confidence: "high",
    evidenceSummary:
      "Neon Steve's official biography identifies him as a Canadian bass house artist.",
    sources: [{ title: "Neon Steve official biography", url: "https://www.neonsteve.com/bio" }],
  },
  rezz: {
    genreSlugs: ["midtempo-bass"],
    confidence: "high",
    evidenceSummary:
      "A public Apple Music editorial profile describes REZZ as a leading midtempo electronic artist.",
    sources: [
      {
        title: "Apple Music artist profile",
        url: "https://music.apple.com/us/artist/rezz/1046759940",
      },
    ],
  },
  "seven-lions": {
    genreSlugs: ["melodic-dubstep", "trance"],
    confidence: "high",
    evidenceSummary:
      "Ophelia Records identifies Seven Lions with melodic dubstep and documents the label's close relationship with trance.",
    sources: [{ title: "Ophelia Records about", url: "https://opheliarecords.com/about/" }],
  },
  soar: {
    genreSlugs: ["melodic-dubstep", "bass-music"],
    confidence: "high",
    evidenceSummary: "Monstercat identifies Soar with melodic dubstep and bass music.",
    sources: [
      { title: "Monstercat artist profile", url: "https://www.monstercat.com/artist/soar" },
    ],
  },
};

const knowledgeSeeds: Readonly<Record<string, readonly PublicGenreSlug[]>> = {
  "3lau": ["future-bass", "progressive-house"],
  "a-m-c": ["drum-and-bass"],
  abelation: ["experimental-bass", "dubstep"],
  "ace-aura": ["riddim", "melodic-dubstep"],
  afrojack: ["electro-house", "progressive-house", "house"],
  akeos: ["riddim", "dubstep"],
  "alison-wonderland": ["trap", "future-bass"],
  alok: ["house"],
  alrt: ["bass-house", "hard-dance"],
  andromedik: ["drum-and-bass"],
  annix: ["drum-and-bass"],
  antiserum: ["trap", "dubstep"],
  apashe: ["trap", "bass-music"],
  armnhmr: ["melodic-dubstep", "future-bass"],
  atliens: ["trap", "bass-music"],
  attlas: ["progressive-house", "house"],
  au5: ["melodic-dubstep", "experimental-bass"],
  autograf: ["house", "future-bass"],
  automhate: ["riddim", "dubstep"],
  badklaat: ["riddim", "dubstep"],
  bandlez: ["riddim", "dubstep"],
  "barclay-crenshaw": ["trap", "bass-music"],
  "barely-alive": ["dubstep"],
  "bear-grillz": ["dubstep"],
  "black-tiger-sex-machine": ["midtempo-bass", "dubstep"],
  "blunts-blondes": ["dubstep", "trap"],
  "blvk-jvck": ["trap"],
  "boogie-t": ["dubstep", "riddim"],
  "boombox-cartel": ["trap", "future-bass"],
  borgore: ["dubstep"],
  "bro-safari": ["trap"],
  brohug: ["bass-house"],
  "champagne-drip": ["experimental-bass", "dubstep"],
  charlesthefirst: ["experimental-bass"],
  chee: ["experimental-bass"],
  chibs: ["riddim"],
  crankdat: ["dubstep"],
  "crystal-skies": ["melodic-dubstep"],
  deathpact: ["midtempo-bass", "experimental-bass"],
  "delta-heavy": ["drum-and-bass"],
  deorro: ["electro-house", "house"],
  "dillon-francis": ["electro-house", "trap"],
  "dion-timmer": ["dubstep", "melodic-dubstep"],
  dirtyphonics: ["drum-and-bass", "dubstep"],
  dmvu: ["experimental-bass"],
  "document-one": ["drum-and-bass", "dubstep"],
  "dodge-fuski": ["dubstep"],
  "don-diablo": ["house", "progressive-house"],
  "dr-fresch": ["bass-house", "house"],
  "dr-ozi": ["dubstep"],
  droeloe: ["future-bass", "experimental-bass"],
  eazybaked: ["experimental-bass"],
  ekali: ["trap", "future-bass"],
  "ekko-sidetrack": ["drum-and-bass"],
  "eli-fur": ["progressive-house", "house"],
  ephwurd: ["bass-house"],
  "fabian-mazur": ["trap", "future-bass"],
};

const labelRules: readonly {
  labels: readonly string[];
  genreSlugs: readonly PublicGenreSlug[];
  description: string;
}[] = [
  {
    labels: ["ophelia"],
    genreSlugs: ["melodic-dubstep", "dubstep", "trance"],
    description: "Ophelia Records label association",
  },
  {
    labels: ["disciple", "never say die", "subsidia", "circus records"],
    genreSlugs: ["dubstep", "bass-music"],
    description: "bass-oriented label association",
  },
  {
    labels: ["wakaan", "odyzey"],
    genreSlugs: ["experimental-bass", "bass-music"],
    description: "experimental bass label association",
  },
  {
    labels: ["night bass", "confession"],
    genreSlugs: ["bass-house", "house"],
    description: "bass house label association",
  },
  {
    labels: ["dirtybird"],
    genreSlugs: ["tech-house", "house"],
    description: "tech house label association",
  },
  {
    labels: ["anjunadeep", "anjunabeats"],
    genreSlugs: ["progressive-house", "trance"],
    description: "Anjuna label association",
  },
  {
    labels: ["ram records", "hospital records", "viper recordings", "pilot records"],
    genreSlugs: ["drum-and-bass"],
    description: "drum and bass label association",
  },
];

function findLabelSuggestion(artist: PublicArtist): ArtistGenreSuggestion | undefined {
  const labels = artist.labelAssociations?.map((label) => label.toLowerCase()) ?? [];
  const matches = labelRules.filter((rule) =>
    labels.some((label) => rule.labels.some((candidate) => label.includes(candidate))),
  );
  if (matches.length === 0) return undefined;
  return {
    genreSlugs: normalizeGenreSlugs(matches.flatMap((match) => match.genreSlugs)),
    confidence: "medium",
    evidenceSummary: `Suggested from ${[...new Set(matches.map((match) => match.description))].join(" and ")}. Confirm against the artist's own catalog before publishing.`,
    sources: [],
  };
}

function findCollaboratorSuggestion(
  artist: PublicArtist,
  releases: readonly PublicRelease[],
  artistsBySlug: ReadonlyMap<string, PublicArtist>,
): ArtistGenreSuggestion | undefined {
  const collaboratorGenres = releases
    .filter((release) => release.artistCredits.some((credit) => credit.artistSlug === artist.slug))
    .flatMap((release) =>
      release.artistCredits.flatMap((credit) => {
        if (credit.artistSlug === undefined || credit.artistSlug === artist.slug) return [];
        return artistsBySlug.get(credit.artistSlug)?.genreSlugs ?? [];
      }),
    );
  const genreSlugs = normalizeGenreSlugs(collaboratorGenres).slice(0, 3);
  if (genreSlugs.length === 0) return undefined;
  return {
    genreSlugs,
    confidence: "low",
    evidenceSummary:
      "Suggested from genres confirmed for collaborators on shared releases. Collaboration is supporting evidence only and requires editorial confirmation.",
    sources: [],
  };
}

function evidenceSourceKind(
  source: ArtistGenreSuggestion["sources"][number],
): ArtistGenreSuggestion["sources"][number]["kind"] {
  const hostname = new URL(source.url).hostname.toLowerCase();
  if (hostname.endsWith("allmusic.com")) return "allmusic";
  if (hostname.endsWith("monstercat.com") || hostname.endsWith("opheliarecords.com")) {
    return "official-label";
  }
  if (source.title.toLowerCase().includes("official")) return "official-artist";
  return "editorial-knowledge";
}

export function getCuratedGenreSuggestion(artist: PublicArtist): ArtistGenreSuggestion | undefined {
  const editorialSlug = artist.slug.replace(/-[a-f0-9]{8}$/, "");
  const sourced = sourcedSeeds[editorialSlug];
  if (sourced === undefined) return undefined;
  const genreSlugs = normalizeGenreSlugs(sourced.genreSlugs);
  return {
    ...sourced,
    genreSlugs,
    confidence: "medium",
    sources: sourced.sources.map((source) => ({
      ...source,
      kind: evidenceSourceKind(source),
      terms: genreSlugs,
      normalizedGenreSlugs: genreSlugs,
      evidenceCount: 1,
    })),
    conflicts: [],
    automationEligible: false,
    researchStatus: "partial",
  };
}

export function suggestArtistGenres(
  artist: PublicArtist,
  releases: readonly PublicRelease[],
  artistsBySlug: ReadonlyMap<string, PublicArtist>,
): ArtistGenreSuggestion {
  const editorialSlug = artist.slug.replace(/-[a-f0-9]{8}$/, "");
  const sourced = getCuratedGenreSuggestion(artist);
  if (sourced !== undefined) return sourced;
  const knowledge = knowledgeSeeds[editorialSlug];
  if (knowledge !== undefined) {
    return {
      genreSlugs: normalizeGenreSlugs(knowledge),
      confidence: "low",
      evidenceSummary:
        "Model-assisted editorial suggestion based on generally recognized artist style. No source has been attached yet, so verify before publishing.",
      sources: [],
      conflicts: [],
      automationEligible: false,
      researchStatus: "legacy",
    };
  }
  const fallback =
    findLabelSuggestion(artist) ??
    findCollaboratorSuggestion(artist, releases, artistsBySlug) ??
    ({
      genreSlugs: ["other-electronic"],
      confidence: "low",
      evidenceSummary:
        "No sufficiently specific public evidence is available in the local catalog. Other Electronic is a review placeholder, not a published classification.",
      sources: [],
    } satisfies ArtistGenreSuggestion);
  return {
    ...fallback,
    confidence: "low",
    conflicts: [],
    automationEligible: false,
    researchStatus: "legacy",
  };
}
