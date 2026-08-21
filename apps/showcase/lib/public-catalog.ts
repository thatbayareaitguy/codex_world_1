export type PublicReleaseStatus = "new" | "upcoming" | "catalog";
export type PublicReleaseType = "Single" | "EP" | "Album";
export type ArtworkTone = "violet" | "citrus" | "cyan" | "rose" | "blue" | "sand";

export interface PublicProviderLinks {
  readonly spotify?: string;
  readonly appleMusic?: string;
}

export interface PublicTrack {
  readonly position: number;
  readonly title: string;
}

export interface PublicRelease {
  readonly publicId: `release_${string}`;
  readonly slug: string;
  readonly title: string;
  readonly artistSlugs: readonly string[];
  readonly type: PublicReleaseType;
  readonly status: PublicReleaseStatus;
  readonly releaseDate: string;
  readonly discoveredDate?: string;
  readonly genres: readonly string[];
  readonly label?: string;
  readonly tracks: readonly PublicTrack[];
  readonly links: PublicProviderLinks;
  readonly artworkTone: ArtworkTone;
}

export interface PublicArtist {
  readonly publicId: `artist_${string}`;
  readonly slug: string;
  readonly name: string;
  readonly genres: readonly string[];
  readonly labelAssociations: readonly string[];
  readonly relatedArtistSlugs: readonly string[];
  readonly links: PublicProviderLinks;
  readonly artworkTone: ArtworkTone;
}

export interface PublicCatalogSnapshot {
  readonly contractVersion: "showcase-public-v0.1";
  readonly generatedAt: string;
  readonly artists: readonly PublicArtist[];
  readonly releases: readonly PublicRelease[];
}

const searchLinks = (name: string): PublicProviderLinks => ({
  spotify: `https://open.spotify.com/search/${encodeURIComponent(name)}`,
  appleMusic: `https://music.apple.com/us/search?term=${encodeURIComponent(name)}`,
});

const artists: readonly PublicArtist[] = [
  {
    publicId: "artist_arden_sol",
    slug: "arden-sol",
    name: "Arden Sol",
    genres: ["Progressive House", "Melodic House"],
    labelAssociations: ["Northline Recordings"],
    relatedArtistSlugs: ["mira-vale", "morrow-house"],
    links: searchLinks("Arden Sol"),
    artworkTone: "violet",
  },
  {
    publicId: "artist_mira_vale",
    slug: "mira-vale",
    name: "Mira Vale",
    genres: ["Melodic Techno", "Electronica"],
    labelAssociations: ["Liminal Works"],
    relatedArtistSlugs: ["arden-sol", "sable-circuit"],
    links: searchLinks("Mira Vale"),
    artworkTone: "rose",
  },
  {
    publicId: "artist_night_service",
    slug: "night-service",
    name: "Night Service",
    genres: ["Drum & Bass", "Jungle"],
    labelAssociations: ["Subframe"],
    relatedArtistSlugs: ["kite-theory"],
    links: searchLinks("Night Service electronic"),
    artworkTone: "cyan",
  },
  {
    publicId: "artist_kite_theory",
    slug: "kite-theory",
    name: "Kite Theory",
    genres: ["UK Garage", "Breaks"],
    labelAssociations: [],
    relatedArtistSlugs: ["night-service", "morrow-house"],
    links: searchLinks("Kite Theory electronic"),
    artworkTone: "citrus",
  },
  {
    publicId: "artist_morrow_house",
    slug: "morrow-house",
    name: "Morrow House",
    genres: ["Deep House", "Electronica"],
    labelAssociations: ["Soft Focus"],
    relatedArtistSlugs: ["arden-sol", "kite-theory"],
    links: searchLinks("Morrow House electronic"),
    artworkTone: "sand",
  },
  {
    publicId: "artist_sable_circuit",
    slug: "sable-circuit",
    name: "Sable Circuit",
    genres: ["Trance", "Techno"],
    labelAssociations: ["Liminal Works"],
    relatedArtistSlugs: ["mira-vale"],
    links: searchLinks("Sable Circuit"),
    artworkTone: "blue",
  },
];

const releases: readonly PublicRelease[] = [
  {
    publicId: "release_afterimage",
    slug: "afterimage",
    title: "Afterimage",
    artistSlugs: ["arden-sol"],
    type: "EP",
    status: "new",
    releaseDate: "2026-08-21",
    discoveredDate: "2026-08-21",
    genres: ["Progressive House", "Melodic House"],
    label: "Northline Recordings",
    tracks: [
      { position: 1, title: "Afterimage" },
      { position: 2, title: "Unfolding Signals" },
      { position: 3, title: "Trace Memory" },
    ],
    links: searchLinks("Arden Sol Afterimage"),
    artworkTone: "violet",
  },
  {
    publicId: "release_static_bloom",
    slug: "static-bloom",
    title: "Static Bloom",
    artistSlugs: ["mira-vale"],
    type: "Single",
    status: "new",
    releaseDate: "2026-08-18",
    discoveredDate: "2026-08-18",
    genres: ["Melodic Techno"],
    label: "Liminal Works",
    tracks: [{ position: 1, title: "Static Bloom" }],
    links: searchLinks("Mira Vale Static Bloom"),
    artworkTone: "rose",
  },
  {
    publicId: "release_night_windows",
    slug: "night-windows",
    title: "Night Windows",
    artistSlugs: ["night-service"],
    type: "Album",
    status: "new",
    releaseDate: "2026-08-14",
    discoveredDate: "2026-08-14",
    genres: ["Drum & Bass", "Jungle"],
    label: "Subframe",
    tracks: [
      { position: 1, title: "Open Late" },
      { position: 2, title: "Night Windows" },
      { position: 3, title: "Signal Path" },
      { position: 4, title: "First Train" },
    ],
    links: searchLinks("Night Service Night Windows"),
    artworkTone: "cyan",
  },
  {
    publicId: "release_soft_signal",
    slug: "soft-signal",
    title: "Soft Signal",
    artistSlugs: ["morrow-house"],
    type: "Single",
    status: "new",
    releaseDate: "2026-08-11",
    discoveredDate: "2026-08-12",
    genres: ["Deep House"],
    label: "Soft Focus",
    tracks: [{ position: 1, title: "Soft Signal" }],
    links: searchLinks("Morrow House Soft Signal"),
    artworkTone: "sand",
  },
  {
    publicId: "release_between_stations",
    slug: "between-stations",
    title: "Between Stations",
    artistSlugs: ["kite-theory", "night-service"],
    type: "Single",
    status: "catalog",
    releaseDate: "2026-07-31",
    discoveredDate: "2026-08-01",
    genres: ["UK Garage", "Breaks"],
    tracks: [{ position: 1, title: "Between Stations" }],
    links: searchLinks("Kite Theory Night Service Between Stations"),
    artworkTone: "citrus",
  },
  {
    publicId: "release_low_tide",
    slug: "low-tide",
    title: "Low Tide",
    artistSlugs: ["arden-sol", "morrow-house"],
    type: "Single",
    status: "catalog",
    releaseDate: "2026-07-17",
    genres: ["Melodic House"],
    label: "Northline Recordings",
    tracks: [{ position: 1, title: "Low Tide" }],
    links: searchLinks("Arden Sol Morrow House Low Tide"),
    artworkTone: "blue",
  },
  {
    publicId: "release_phase_lines",
    slug: "phase-lines",
    title: "Phase Lines",
    artistSlugs: ["kite-theory"],
    type: "EP",
    status: "upcoming",
    releaseDate: "2026-08-28",
    genres: ["UK Garage", "Breaks"],
    tracks: [
      { position: 1, title: "Phase Lines" },
      { position: 2, title: "Zero Crossing" },
      { position: 3, title: "Overground" },
    ],
    links: searchLinks("Kite Theory Phase Lines"),
    artworkTone: "citrus",
  },
  {
    publicId: "release_coastline_error",
    slug: "coastline-error",
    title: "Coastline Error",
    artistSlugs: ["sable-circuit"],
    type: "Album",
    status: "upcoming",
    releaseDate: "2026-09-04",
    genres: ["Trance", "Techno"],
    label: "Liminal Works",
    tracks: [
      { position: 1, title: "Blue Shift" },
      { position: 2, title: "Coastline Error" },
      { position: 3, title: "Vector Field" },
      { position: 4, title: "Long Arc" },
    ],
    links: searchLinks("Sable Circuit Coastline Error"),
    artworkTone: "blue",
  },
];

export const publicCatalog: PublicCatalogSnapshot = {
  contractVersion: "showcase-public-v0.1",
  generatedAt: "2026-08-21T12:00:00-07:00",
  artists,
  releases,
};

export const getArtist = (slug: string): PublicArtist | undefined =>
  publicCatalog.artists.find((artist) => artist.slug === slug);

export const getRelease = (slug: string): PublicRelease | undefined =>
  publicCatalog.releases.find((release) => release.slug === slug);

export const getReleaseArtists = (release: PublicRelease): readonly PublicArtist[] =>
  release.artistSlugs.flatMap((slug) => {
    const artist = getArtist(slug);
    return artist === undefined ? [] : [artist];
  });

export const getArtistReleases = (artistSlug: string): readonly PublicRelease[] =>
  publicCatalog.releases.filter((release) => release.artistSlugs.includes(artistSlug));

export const formatPublicDate = (date: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
