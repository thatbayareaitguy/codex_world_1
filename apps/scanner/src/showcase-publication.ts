import {
  appleIdentityCandidateCatalogs,
  artistExternalIds,
  artistFollows,
  artists,
  releaseCandidates,
  releaseExternalIds,
  releaseProviderReconciliations,
  releaseTrackAppearances,
  releaseTrackAppearanceSources,
  tracks,
  type RadarDatabase,
} from "@radar/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

const publicReleaseTypes = [
  "Single",
  "EP",
  "Album",
  "Compilation",
  "Remix",
  "Live",
  "Mixtape",
  "DJ Mix",
  "Soundtrack",
  "Other",
] as const;

const artworkTones = ["violet", "citrus", "cyan", "rose", "blue", "sand"] as const;

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

export type ShowcaseGenreSlug = (typeof showcaseGenreSlugs)[number];

export const showcaseGenreTaxonomy: readonly {
  readonly name: string;
  readonly slug: ShowcaseGenreSlug;
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

const providerGenreToShowcaseGenre: Readonly<Record<string, ShowcaseGenreSlug>> = {
  ambient: "other-electronic",
  bass: "bass-music",
  "bass house": "bass-house",
  "bass music": "bass-music",
  breakbeat: "bass-music",
  breaks: "bass-music",
  dance: "other-electronic",
  downtempo: "other-electronic",
  "drum & bass": "drum-and-bass",
  "drum and bass": "drum-and-bass",
  "jungle/drum'n'bass": "drum-and-bass",
  dubstep: "dubstep",
  "electro house": "electro-house",
  electronic: "other-electronic",
  electronica: "other-electronic",
  experimental: "experimental-bass",
  "experimental bass": "experimental-bass",
  "future bass": "future-bass",
  garage: "bass-music",
  hardcore: "hard-dance",
  "hard dance": "hard-dance",
  house: "house",
  industrial: "other-electronic",
  "idm/experimental": "experimental-bass",
  "melodic dubstep": "melodic-dubstep",
  "midtempo bass": "midtempo-bass",
  riddim: "riddim",
  "progressive house": "progressive-house",
  "tech house": "tech-house",
  techno: "techno",
  trance: "trance",
  trap: "trap",
};

const showcaseGenreOrder = new Map(showcaseGenreSlugs.map((slug, index) => [slug, index] as const));

const publicTrackSchema = z
  .object({
    discNumber: z.number().int().positive(),
    position: z.number().int().positive(),
    title: z.string().trim().min(1).max(500),
  })
  .strict();

const publicLinksSchema = z
  .object({
    appleMusic: z.url(),
    spotify: z.url().optional(),
  })
  .strict();

const publicArtworkSchema = z
  .object({
    height: z.number().int().positive().max(10_000),
    source: z.literal("apple_music"),
    url: z.url(),
    width: z.number().int().positive().max(10_000),
  })
  .strict();

export const showcasePublicGenreSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    slug: z.enum(showcaseGenreSlugs),
  })
  .strict();

export const showcasePublicArtistSchema = z
  .object({
    publicId: z.string().regex(/^artist_[a-f0-9]{20}$/),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().trim().min(1).max(500),
    genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
    labelAssociations: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    links: publicLinksSchema,
    artworkTone: z.enum(artworkTones),
  })
  .strict();

const publicArtistCreditSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    artistSlug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict();

export const showcasePublicReleaseSchema = z
  .object({
    publicId: z.string().regex(/^release_[a-f0-9]{20}$/),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    artistCredits: z.array(publicArtistCreditSchema).min(1).max(50),
    title: z.string().trim().min(1).max(500),
    type: z.enum(publicReleaseTypes),
    status: z.enum(["upcoming", "released"]),
    releaseDate: z.iso.date(),
    firstDiscoveredDate: z.iso.date(),
    genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
    label: z.string().trim().min(1).max(300).optional(),
    tracks: z.array(publicTrackSchema).max(500),
    links: publicLinksSchema,
    artwork: publicArtworkSchema.optional(),
    artworkTone: z.enum(artworkTones),
  })
  .strict();

export const showcasePublicCatalogSchema = z
  .object({
    contractVersion: z.literal("showcase-public-v3"),
    generatedAt: z.iso.datetime({ offset: true }),
    genres: z.array(showcasePublicGenreSchema),
    artists: z.array(showcasePublicArtistSchema),
    releases: z.array(showcasePublicReleaseSchema),
  })
  .strict();

export type ShowcasePublicArtist = z.infer<typeof showcasePublicArtistSchema>;
export type ShowcasePublicCatalog = z.infer<typeof showcasePublicCatalogSchema>;
export type ShowcasePublicRelease = z.infer<typeof showcasePublicReleaseSchema>;

export interface ShowcaseSourceArtist {
  readonly appleMusicUrl: string;
  readonly appleProviderArtistId: string;
  readonly labelAssociations: readonly string[];
  readonly name: string;
  readonly providerGenres: readonly string[];
  readonly spotifyUrl?: string;
}

export interface ShowcaseSourceArtistCredit {
  readonly appleProviderArtistId?: string;
  readonly name: string;
}

export interface ShowcaseSourceTrack {
  readonly discNumber: number;
  readonly position: number;
  readonly title: string;
}

export interface ShowcaseSourceArtwork {
  readonly height: number;
  readonly source: "apple_music";
  readonly url: string;
  readonly width: number;
}

export interface ShowcaseSourceRelease {
  readonly appleProviderReleaseId: string;
  readonly appleMusicUrl: string;
  readonly artwork?: ShowcaseSourceArtwork;
  readonly artistCredits: readonly ShowcaseSourceArtistCredit[];
  readonly firstDiscoveredAt: Date;
  readonly genreOverrideSlugs?: readonly ShowcaseGenreSlug[];
  readonly label?: string;
  readonly primaryAppleArtistId: string;
  readonly releaseDate: string;
  readonly releaseType: string;
  readonly spotifyUrl?: string;
  readonly title: string;
  readonly tracks: readonly ShowcaseSourceTrack[];
}

export interface ShowcasePublicationSource {
  readonly artists: readonly ShowcaseSourceArtist[];
  readonly invalidActiveArtistCount: number;
  readonly invalidAppleReleaseCount: number;
  readonly releases: readonly ShowcaseSourceRelease[];
  readonly unresolvedCollaboratorCount: number;
}

export interface ShowcasePublicationResult {
  readonly artistCount: number;
  readonly artistsWithGenresCount: number;
  readonly catalog: ShowcasePublicCatalog;
  readonly invalidActiveArtistCount: number;
  readonly invalidAppleReleaseCount: number;
  readonly multiCreditReleaseCount: number;
  readonly releaseCount: number;
  readonly unresolvedCollaboratorCount: number;
  readonly withSpotifyCount: number;
  readonly withoutSpotifyCount: number;
  readonly withArtworkCount: number;
  readonly withoutArtworkCount: number;
}

const publicTypeByCanonicalType: Readonly<Record<string, (typeof publicReleaseTypes)[number]>> = {
  album: "Album",
  compilation: "Compilation",
  dj_mix: "DJ Mix",
  ep: "EP",
  live: "Live",
  mixtape: "Mixtape",
  remix: "Remix",
  single: "Single",
  soundtrack: "Soundtrack",
};

const strictSpotifyReconciliationStatuses = new Set(["matched", "missing_spotify_track"]);

export async function loadShowcasePublicationSource(
  db: RadarDatabase,
): Promise<ShowcasePublicationSource> {
  const activeRows = await db
    .select({ artistId: artists.id, name: artists.name })
    .from(artistFollows)
    .innerJoin(artists, eq(artists.id, artistFollows.artistId))
    .where(eq(artistFollows.active, true))
    .orderBy(asc(artists.name), asc(artists.id));
  const activeArtistsById = new Map(
    activeRows.map((row) => [row.artistId, { artistId: row.artistId, name: row.name }]),
  );
  const activeArtistIds = [...activeArtistsById.keys()];
  if (activeArtistIds.length === 0) {
    return {
      artists: [],
      invalidActiveArtistCount: 0,
      invalidAppleReleaseCount: 0,
      releases: [],
      unresolvedCollaboratorCount: 0,
    };
  }

  const mappingRows = await db
    .select({
      artistId: artistExternalIds.artistId,
      externalId: artistExternalIds.externalId,
      provider: artistExternalIds.provider,
      providerUrl: artistExternalIds.providerUrl,
    })
    .from(artistExternalIds)
    .where(
      and(
        eq(artistExternalIds.confirmed, true),
        inArray(artistExternalIds.artistId, activeArtistIds),
        inArray(artistExternalIds.provider, ["apple_music", "spotify"]),
      ),
    )
    .orderBy(asc(artistExternalIds.artistId), asc(artistExternalIds.provider));
  const mappingsByArtistId = groupBy(mappingRows, (row) => row.artistId);
  const appleProviderArtistIds = mappingRows
    .filter((row) => row.provider === "apple_music")
    .map((row) => row.externalId);
  const primaryCatalogRows = appleProviderArtistIds.length
    ? await db
        .select({
          appleArtistId: appleIdentityCandidateCatalogs.appleArtistId,
          catalog: appleIdentityCandidateCatalogs.catalog,
        })
        .from(appleIdentityCandidateCatalogs)
        .where(inArray(appleIdentityCandidateCatalogs.appleArtistId, appleProviderArtistIds))
        .orderBy(asc(appleIdentityCandidateCatalogs.appleArtistId))
    : [];
  const primaryCatalogByAppleId = new Map(
    primaryCatalogRows.map((row) => [row.appleArtistId, row.catalog]),
  );

  const sourceArtists: ShowcaseSourceArtist[] = [];
  let invalidActiveArtistCount = 0;
  for (const activeArtist of activeArtistsById.values()) {
    const mappings = mappingsByArtistId.get(activeArtist.artistId) ?? [];
    const appleMapping = mappings.find((mapping) => mapping.provider === "apple_music");
    if (appleMapping === undefined) {
      invalidActiveArtistCount += 1;
      continue;
    }
    const catalog = primaryCatalogByAppleId.get(appleMapping.externalId);
    const appleMusicUrl = appleMapping.providerUrl ?? catalog?.artistUrl;
    if (appleMusicUrl === null || appleMusicUrl === undefined) {
      invalidActiveArtistCount += 1;
      continue;
    }
    const spotifyMapping = mappings.find((mapping) => mapping.provider === "spotify");
    const sourceArtist: ShowcaseSourceArtist = {
      appleMusicUrl,
      appleProviderArtistId: appleMapping.externalId,
      labelAssociations:
        catalog?.resourceStatus === "valid" ? uniquePublicLabels(catalog.labels) : [],
      name: activeArtist.name,
      providerGenres: catalog?.resourceStatus === "valid" ? catalog.genres : [],
      ...(spotifyMapping?.providerUrl === null || spotifyMapping?.providerUrl === undefined
        ? {}
        : { spotifyUrl: spotifyMapping.providerUrl }),
    };
    sourceArtists.push(sourceArtist);
  }
  const sourceArtistByAppleId = new Map(
    sourceArtists.map((artist) => [artist.appleProviderArtistId, artist]),
  );
  const sourceArtistByName = new Map(
    sourceArtists.map((artist) => [normalizePublicName(artist.name), artist]),
  );

  const releaseMetadataByAppleId = new Map<string, { artistIds: string[]; labels: Set<string> }>();
  for (const row of primaryCatalogRows) {
    if (row.catalog.resourceStatus !== "valid") continue;
    for (const release of row.catalog.releases) {
      const metadata = releaseMetadataByAppleId.get(release.appleReleaseId) ?? {
        artistIds: [],
        labels: new Set<string>(),
      };
      for (const artistId of release.artistIds) {
        if (!metadata.artistIds.includes(artistId)) metadata.artistIds.push(artistId);
      }
      if (release.label) metadata.labels.add(release.label);
      releaseMetadataByAppleId.set(release.appleReleaseId, metadata);
    }
  }
  const collaboratorAppleIds = [
    ...new Set([...releaseMetadataByAppleId.values()].flatMap((metadata) => metadata.artistIds)),
  ].filter((artistId) => !sourceArtistByAppleId.has(artistId));
  const collaboratorCatalogRows = collaboratorAppleIds.length
    ? await db
        .select({
          appleArtistId: appleIdentityCandidateCatalogs.appleArtistId,
          catalog: appleIdentityCandidateCatalogs.catalog,
        })
        .from(appleIdentityCandidateCatalogs)
        .where(inArray(appleIdentityCandidateCatalogs.appleArtistId, collaboratorAppleIds))
        .orderBy(asc(appleIdentityCandidateCatalogs.appleArtistId))
    : [];
  const collaboratorNameByAppleId = new Map(
    collaboratorCatalogRows.flatMap((row) =>
      row.catalog.resourceStatus === "valid" && row.catalog.artistName.trim()
        ? [[row.appleArtistId, row.catalog.artistName.trim()] as const]
        : [],
    ),
  );

  if (sourceArtists.length === 0) {
    return {
      artists: [],
      invalidActiveArtistCount,
      invalidAppleReleaseCount: 0,
      releases: [],
      unresolvedCollaboratorCount: 0,
    };
  }

  const candidateRows = await db
    .select({
      artistExternalId: releaseCandidates.artistExternalId,
      firstSeenAt: releaseCandidates.firstSeenAt,
      providerReleaseId: releaseCandidates.providerReleaseId,
      rawPayload: releaseCandidates.rawPayload,
      releaseDate: releaseCandidates.releaseDate,
    })
    .from(releaseCandidates)
    .where(
      and(
        eq(releaseCandidates.provider, "apple_music"),
        inArray(releaseCandidates.artistExternalId, [...sourceArtistByAppleId.keys()]),
      ),
    )
    .orderBy(asc(releaseCandidates.firstSeenAt));
  const appleProviderReleaseIds = [...new Set(candidateRows.map((row) => row.providerReleaseId))];
  if (appleProviderReleaseIds.length === 0) {
    return {
      artists: sourceArtists,
      invalidActiveArtistCount,
      invalidAppleReleaseCount: 0,
      releases: [],
      unresolvedCollaboratorCount: 0,
    };
  }

  const appleReleaseRows = await db
    .select({
      appleMusicUrl: releaseExternalIds.providerUrl,
      appleProviderReleaseId: releaseExternalIds.externalId,
    })
    .from(releaseExternalIds)
    .where(
      and(
        eq(releaseExternalIds.provider, "apple_music"),
        inArray(releaseExternalIds.externalId, appleProviderReleaseIds),
      ),
    )
    .orderBy(asc(releaseExternalIds.externalId));
  const trackRows = await db
    .select({
      discNumber: releaseTrackAppearances.discNumber,
      position: releaseTrackAppearances.trackNumber,
      providerOrder: releaseTrackAppearances.providerOrder,
      providerReleaseId: releaseTrackAppearanceSources.providerReleaseId,
      title: tracks.title,
    })
    .from(releaseTrackAppearanceSources)
    .innerJoin(
      releaseTrackAppearances,
      eq(releaseTrackAppearanceSources.appearanceId, releaseTrackAppearances.id),
    )
    .innerJoin(tracks, eq(releaseTrackAppearances.trackId, tracks.id))
    .where(
      and(
        eq(releaseTrackAppearanceSources.provider, "apple_music"),
        inArray(releaseTrackAppearanceSources.providerReleaseId, appleProviderReleaseIds),
      ),
    )
    .orderBy(
      asc(releaseTrackAppearanceSources.providerReleaseId),
      asc(releaseTrackAppearances.discNumber),
      asc(releaseTrackAppearances.trackNumber),
    );
  const reconciliationRows = await db
    .select({
      appleProviderReleaseId: releaseProviderReconciliations.appleProviderReleaseId,
      spotifyProviderReleaseId: releaseProviderReconciliations.spotifyProviderReleaseId,
      status: releaseProviderReconciliations.status,
    })
    .from(releaseProviderReconciliations)
    .where(inArray(releaseProviderReconciliations.appleProviderReleaseId, appleProviderReleaseIds))
    .orderBy(
      desc(releaseProviderReconciliations.updatedAt),
      desc(releaseProviderReconciliations.createdAt),
    );
  const latestReconciliationByAppleId = new Map<string, (typeof reconciliationRows)[number]>();
  for (const row of reconciliationRows) {
    if (
      row.appleProviderReleaseId !== null &&
      !latestReconciliationByAppleId.has(row.appleProviderReleaseId)
    ) {
      latestReconciliationByAppleId.set(row.appleProviderReleaseId, row);
    }
  }
  const confirmedSpotifyIds = [
    ...new Set(
      [...latestReconciliationByAppleId.values()].flatMap((row) =>
        strictSpotifyReconciliationStatuses.has(row.status) && row.spotifyProviderReleaseId !== null
          ? [row.spotifyProviderReleaseId]
          : [],
      ),
    ),
  ];
  const spotifyRows = confirmedSpotifyIds.length
    ? await db
        .select({
          externalId: releaseExternalIds.externalId,
          providerUrl: releaseExternalIds.providerUrl,
        })
        .from(releaseExternalIds)
        .where(
          and(
            eq(releaseExternalIds.provider, "spotify"),
            inArray(releaseExternalIds.externalId, confirmedSpotifyIds),
          ),
        )
    : [];

  const candidatesByReleaseId = groupBy(candidateRows, (row) => row.providerReleaseId);
  const tracksByReleaseId = groupBy(trackRows, (row) => row.providerReleaseId);
  const spotifyUrlByExternalId = new Map(
    spotifyRows.map((row) => [row.externalId, row.providerUrl]),
  );
  const sourceReleases: ShowcaseSourceRelease[] = [];
  let invalidAppleReleaseCount = 0;
  let unresolvedCollaboratorCount = 0;

  for (const row of appleReleaseRows) {
    const candidates = candidatesByReleaseId.get(row.appleProviderReleaseId) ?? [];
    const firstCandidate = candidates[0];
    const primaryArtist =
      firstCandidate === undefined
        ? undefined
        : sourceArtistByAppleId.get(firstCandidate.artistExternalId);
    const appleMetadata =
      firstCandidate === undefined ? undefined : appleCandidateMetadata(firstCandidate.rawPayload);
    if (
      firstCandidate === undefined ||
      primaryArtist === undefined ||
      appleMetadata === undefined
    ) {
      invalidAppleReleaseCount += 1;
      continue;
    }

    const releaseMetadata = releaseMetadataByAppleId.get(row.appleProviderReleaseId);
    const credits: ShowcaseSourceArtistCredit[] = [
      {
        appleProviderArtistId: primaryArtist.appleProviderArtistId,
        name: primaryArtist.name,
      },
    ];
    for (const appleArtistId of releaseMetadata?.artistIds ?? []) {
      if (appleArtistId === primaryArtist.appleProviderArtistId) continue;
      const publishedArtist = sourceArtistByAppleId.get(appleArtistId);
      if (publishedArtist !== undefined) {
        credits.push({
          appleProviderArtistId: publishedArtist.appleProviderArtistId,
          name: publishedArtist.name,
        });
        continue;
      }
      const collaboratorName = collaboratorNameByAppleId.get(appleArtistId);
      if (collaboratorName === undefined) {
        unresolvedCollaboratorCount += 1;
        continue;
      }
      credits.push({ name: collaboratorName });
    }
    for (const rawCreditName of appleMetadata.creditNames) {
      const publishedArtist = sourceArtistByName.get(normalizePublicName(rawCreditName));
      credits.push(
        publishedArtist === undefined
          ? { name: rawCreditName }
          : {
              appleProviderArtistId: publishedArtist.appleProviderArtistId,
              name: publishedArtist.name,
            },
      );
    }
    const reconciliation = latestReconciliationByAppleId.get(row.appleProviderReleaseId);
    const spotifyUrl =
      reconciliation !== undefined &&
      strictSpotifyReconciliationStatuses.has(reconciliation.status) &&
      reconciliation.spotifyProviderReleaseId !== null
        ? spotifyUrlByExternalId.get(reconciliation.spotifyProviderReleaseId)
        : undefined;
    const sourceTracks = (tracksByReleaseId.get(row.appleProviderReleaseId) ?? []).map((track) => ({
      discNumber: track.discNumber,
      position: track.providerOrder ?? track.position,
      title: track.title,
    }));
    const label = [...(releaseMetadata?.labels ?? [])]
      .map((value) => sanitizePublicLabel(value))
      .filter((value): value is string => value !== undefined)
      .sort((left, right) => left.localeCompare(right))[0];

    sourceReleases.push({
      appleMusicUrl: row.appleMusicUrl,
      appleProviderReleaseId: row.appleProviderReleaseId,
      artistCredits: uniqueSourceCredits(credits),
      firstDiscoveredAt: firstCandidate.firstSeenAt,
      ...(label === undefined ? {} : { label }),
      primaryAppleArtistId: primaryArtist.appleProviderArtistId,
      releaseDate: firstCandidate.releaseDate,
      releaseType: appleMetadata.releaseType,
      ...(spotifyUrl === undefined ? {} : { spotifyUrl }),
      title: appleMetadata.releaseTitle,
      tracks: sourceTracks,
    });
  }

  return {
    artists: sourceArtists,
    invalidActiveArtistCount,
    invalidAppleReleaseCount,
    releases: sourceReleases,
    unresolvedCollaboratorCount,
  };
}

export function buildShowcasePublicCatalog(
  source: ShowcasePublicationSource,
  generatedAt = new Date(),
): ShowcasePublicationResult {
  const publicArtistByAppleId = new Map<string, ShowcasePublicArtist>();
  const artists = source.artists
    .flatMap((artist) => {
      const appleMusicUrl = validatedProviderUrl(
        artist.appleMusicUrl,
        "music.apple.com",
        "/artist/",
      );
      if (appleMusicUrl === undefined) return [];
      const spotifyUrl =
        artist.spotifyUrl === undefined
          ? undefined
          : validatedProviderUrl(artist.spotifyUrl, "open.spotify.com", "/artist/");
      const identityHash = stableHash("artist", artist.appleProviderArtistId);
      const labelAssociations = uniquePublicLabels(artist.labelAssociations);
      const publicArtist = {
        publicId: `artist_${identityHash.slice(0, 20)}`,
        slug: `${slugify(artist.name)}-${identityHash.slice(0, 8)}`,
        name: artist.name.trim(),
        genreSlugs: mapProviderGenresToShowcase(artist.providerGenres),
        ...(labelAssociations.length ? { labelAssociations } : {}),
        links: {
          appleMusic: appleMusicUrl,
          ...(spotifyUrl === undefined ? {} : { spotify: spotifyUrl }),
        },
        artworkTone:
          artworkTones[Number.parseInt(identityHash.slice(0, 2), 16) % artworkTones.length]!,
      } satisfies ShowcasePublicArtist;
      const parsed = showcasePublicArtistSchema.safeParse(publicArtist);
      if (!parsed.success) return [];
      publicArtistByAppleId.set(artist.appleProviderArtistId, parsed.data);
      return [parsed.data];
    })
    .sort(
      (left, right) => left.name.localeCompare(right.name) || left.slug.localeCompare(right.slug),
    );

  const releases = source.releases
    .flatMap((release) => {
      const primaryArtist = publicArtistByAppleId.get(release.primaryAppleArtistId);
      if (primaryArtist === undefined) return [];
      const appleMusicUrl = validatedProviderUrl(
        release.appleMusicUrl,
        "music.apple.com",
        "/album/",
      );
      if (appleMusicUrl === undefined) return [];
      const spotifyUrl =
        release.spotifyUrl === undefined
          ? undefined
          : validatedProviderUrl(release.spotifyUrl, "open.spotify.com", "/album/");
      const identityHash = stableHash("release", release.appleProviderReleaseId);
      const artistCredits = uniquePublicCredits(
        release.artistCredits.map((credit) => {
          const publishedArtist =
            credit.appleProviderArtistId === undefined
              ? undefined
              : publicArtistByAppleId.get(credit.appleProviderArtistId);
          return publishedArtist === undefined
            ? { name: credit.name.trim() }
            : { artistSlug: publishedArtist.slug, name: publishedArtist.name };
        }),
      );
      if (!artistCredits.some((credit) => credit.artistSlug === primaryArtist.slug)) {
        artistCredits.unshift({ artistSlug: primaryArtist.slug, name: primaryArtist.name });
      }
      const inheritedGenres = artistCredits.flatMap((credit) => {
        if (credit.artistSlug === undefined) return [];
        const artist = artists.find((item) => item.slug === credit.artistSlug);
        return artist?.genreSlugs ?? [];
      });
      const genreSlugs = [...new Set(release.genreOverrideSlugs ?? inheritedGenres)]
        .filter(isShowcaseGenreSlug)
        .sort(
          (left, right) =>
            (showcaseGenreOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (showcaseGenreOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
        );
      const label = release.label === undefined ? undefined : sanitizePublicLabel(release.label);
      const artwork = validatedAppleArtwork(release.artwork);
      const publicRelease = {
        publicId: `release_${identityHash.slice(0, 20)}`,
        slug: `${slugify(`${primaryArtist.name}-${release.title}`)}-${identityHash.slice(0, 8)}`,
        artistCredits,
        title: release.title.trim(),
        type: publicTypeByCanonicalType[release.releaseType] ?? "Other",
        status: release.releaseDate > isoDate(generatedAt) ? "upcoming" : "released",
        releaseDate: release.releaseDate,
        firstDiscoveredDate: isoDate(release.firstDiscoveredAt),
        genreSlugs,
        ...(label === undefined ? {} : { label }),
        tracks: release.tracks.map((track) => ({
          discNumber: track.discNumber,
          position: track.position,
          title: track.title.trim(),
        })),
        links: {
          appleMusic: appleMusicUrl,
          ...(spotifyUrl === undefined ? {} : { spotify: spotifyUrl }),
        },
        ...(artwork === undefined ? {} : { artwork }),
        artworkTone:
          artworkTones[Number.parseInt(identityHash.slice(0, 2), 16) % artworkTones.length]!,
      } satisfies ShowcasePublicRelease;
      const parsed = showcasePublicReleaseSchema.safeParse(publicRelease);
      return parsed.success ? [parsed.data] : [];
    })
    .sort(
      (left, right) =>
        right.releaseDate.localeCompare(left.releaseDate) || left.slug.localeCompare(right.slug),
    );
  const catalog = showcasePublicCatalogSchema.parse({
    contractVersion: "showcase-public-v3",
    generatedAt: generatedAt.toISOString(),
    genres: showcaseGenreTaxonomy,
    artists,
    releases,
  });
  const withSpotifyCount = releases.filter((release) => release.links.spotify !== undefined).length;
  const withArtworkCount = releases.filter((release) => release.artwork !== undefined).length;
  return {
    artistCount: artists.length,
    artistsWithGenresCount: artists.filter((artist) => artist.genreSlugs.length > 0).length,
    catalog,
    invalidActiveArtistCount:
      source.invalidActiveArtistCount + source.artists.length - artists.length,
    invalidAppleReleaseCount:
      source.invalidAppleReleaseCount + source.releases.length - releases.length,
    multiCreditReleaseCount: releases.filter((release) => release.artistCredits.length > 1).length,
    releaseCount: releases.length,
    unresolvedCollaboratorCount: source.unresolvedCollaboratorCount,
    withSpotifyCount,
    withoutSpotifyCount: releases.length - withSpotifyCount,
    withArtworkCount,
    withoutArtworkCount: releases.length - withArtworkCount,
  };
}

export function mapProviderGenresToShowcase(
  providerGenres: readonly string[],
): ShowcaseGenreSlug[] {
  return [
    ...new Set(
      providerGenres.flatMap((genre) => {
        const mapped = providerGenreToShowcaseGenre[genre.trim().toLowerCase()];
        return mapped === undefined ? [] : [mapped];
      }),
    ),
  ].sort(
    (left, right) =>
      (showcaseGenreOrder.get(left) ?? Number.MAX_SAFE_INTEGER) -
      (showcaseGenreOrder.get(right) ?? Number.MAX_SAFE_INTEGER),
  );
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function stableHash(kind: "artist" | "release", value: string): string {
  return createHash("sha256").update(`showcase-${kind}-v1:${value}`).digest("hex");
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120)
    .replace(/-$/g, "");
  return slug || "record";
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function appleCandidateMetadata(
  value: unknown,
): { creditNames: string[]; releaseTitle: string; releaseType: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.releaseTitle !== "string" || typeof record.releaseType !== "string") {
    return undefined;
  }
  const creditNames = Array.isArray(record.credits)
    ? record.credits.flatMap((credit) => {
        if (typeof credit !== "object" || credit === null || Array.isArray(credit)) return [];
        const name = (credit as Record<string, unknown>).name;
        return typeof name === "string" && name.trim() ? [name.trim()] : [];
      })
    : [];
  return { creditNames, releaseTitle: record.releaseTitle, releaseType: record.releaseType };
}

function validatedProviderUrl(
  value: string,
  expectedHost: string,
  requiredPathSegment: string,
): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== expectedHost ||
      url.username !== "" ||
      url.password !== "" ||
      !url.pathname.includes(requiredPathSegment)
    ) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function validatedAppleArtwork(
  artwork: ShowcaseSourceArtwork | undefined,
): ShowcaseSourceArtwork | undefined {
  if (artwork === undefined || artwork.source !== "apple_music") return undefined;
  if (
    !Number.isInteger(artwork.width) ||
    artwork.width < 1 ||
    artwork.width > 10_000 ||
    !Number.isInteger(artwork.height) ||
    artwork.height < 1 ||
    artwork.height > 10_000
  ) {
    return undefined;
  }
  try {
    const url = new URL(artwork.url);
    if (
      url.protocol !== "https:" ||
      !/^is[1-5]-ssl\.mzstatic\.com$/.test(url.hostname) ||
      !url.pathname.startsWith("/image/thumb/") ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.hash !== ""
    ) {
      return undefined;
    }
    return { ...artwork, url: url.toString() };
  } catch {
    return undefined;
  }
}

function uniqueSourceCredits(
  credits: readonly ShowcaseSourceArtistCredit[],
): ShowcaseSourceArtistCredit[] {
  const seen = new Set<string>();
  return credits.flatMap((credit) => {
    const name = credit.name.trim();
    if (!name) return [];
    const key = credit.appleProviderArtistId ?? normalizePublicName(name);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      credit.appleProviderArtistId === undefined
        ? { name }
        : { appleProviderArtistId: credit.appleProviderArtistId, name },
    ];
  });
}

function uniquePublicCredits<T extends { readonly artistSlug?: string; readonly name: string }>(
  credits: readonly T[],
): T[] {
  const seen = new Set<string>();
  return credits.flatMap((credit) => {
    if (!credit.name) return [];
    const key = credit.artistSlug ?? normalizePublicName(credit.name);
    if (seen.has(key)) return [];
    seen.add(key);
    return [credit];
  });
}

function uniquePublicLabels(labels: readonly string[]): string[] {
  return [
    ...new Set(
      labels
        .map((label) => sanitizePublicLabel(label))
        .filter((label): label is string => label !== undefined),
    ),
  ]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 20);
}

function sanitizePublicLabel(value: string): string | undefined {
  const label = value.trim();
  return label && label.length <= 300 ? label : undefined;
}

function normalizePublicName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function isShowcaseGenreSlug(value: string): value is ShowcaseGenreSlug {
  return (showcaseGenreSlugs as readonly string[]).includes(value);
}
