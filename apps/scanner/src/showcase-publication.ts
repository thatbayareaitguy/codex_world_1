import {
  artistExternalIds,
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

export const showcasePublicReleaseSchema = z
  .object({
    publicId: z.string().regex(/^release_[a-f0-9]{20}$/),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    artistName: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(500),
    type: z.enum(publicReleaseTypes),
    status: z.enum(["upcoming", "released"]),
    releaseDate: z.iso.date(),
    firstDiscoveredDate: z.iso.date(),
    genres: z.array(z.string().trim().min(1).max(100)).max(20),
    label: z.string().trim().min(1).max(300).optional(),
    tracks: z.array(publicTrackSchema).max(500),
    links: publicLinksSchema,
    artworkTone: z.enum(artworkTones),
  })
  .strict();

export const showcasePublicCatalogSchema = z
  .object({
    contractVersion: z.literal("showcase-public-v1"),
    generatedAt: z.iso.datetime({ offset: true }),
    releases: z.array(showcasePublicReleaseSchema),
  })
  .strict();

export type ShowcasePublicCatalog = z.infer<typeof showcasePublicCatalogSchema>;
export type ShowcasePublicRelease = z.infer<typeof showcasePublicReleaseSchema>;

export interface ShowcaseSourceTrack {
  readonly discNumber: number;
  readonly position: number;
  readonly title: string;
}

export interface ShowcaseSourceRelease {
  readonly appleProviderReleaseId: string;
  readonly appleMusicUrl: string;
  readonly artistName: string;
  readonly firstDiscoveredAt: Date;
  readonly releaseDate: string;
  readonly releaseType: string;
  readonly spotifyUrl?: string;
  readonly title: string;
  readonly tracks: readonly ShowcaseSourceTrack[];
}

export interface ShowcasePublicationSource {
  readonly invalidAppleReleaseCount: number;
  readonly releases: readonly ShowcaseSourceRelease[];
}

export interface ShowcasePublicationResult {
  readonly catalog: ShowcasePublicCatalog;
  readonly invalidAppleReleaseCount: number;
  readonly releaseCount: number;
  readonly withSpotifyCount: number;
  readonly withoutSpotifyCount: number;
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
  const appleReleaseRows = await db
    .select({
      appleMusicUrl: releaseExternalIds.providerUrl,
      appleProviderReleaseId: releaseExternalIds.externalId,
    })
    .from(releaseExternalIds)
    .where(eq(releaseExternalIds.provider, "apple_music"))
    .orderBy(asc(releaseExternalIds.externalId));

  if (appleReleaseRows.length === 0) return { invalidAppleReleaseCount: 0, releases: [] };

  const appleProviderReleaseIds = appleReleaseRows.map((row) => row.appleProviderReleaseId);
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
        inArray(releaseCandidates.providerReleaseId, appleProviderReleaseIds),
      ),
    )
    .orderBy(asc(releaseCandidates.firstSeenAt));

  const artistExternalIdValues = [...new Set(candidateRows.map((row) => row.artistExternalId))];
  const artistRows =
    artistExternalIdValues.length === 0
      ? []
      : await db
          .select({
            externalId: artistExternalIds.externalId,
            name: artists.name,
          })
          .from(artistExternalIds)
          .innerJoin(artists, eq(artistExternalIds.artistId, artists.id))
          .where(
            and(
              eq(artistExternalIds.provider, "apple_music"),
              eq(artistExternalIds.confirmed, true),
              inArray(artistExternalIds.externalId, artistExternalIdValues),
            ),
          );

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
  const spotifyRows =
    confirmedSpotifyIds.length === 0
      ? []
      : await db
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
          );

  const candidatesByReleaseId = groupBy(candidateRows, (row) => row.providerReleaseId);
  const tracksByReleaseId = groupBy(trackRows, (row) => row.providerReleaseId);
  const artistNameByExternalId = new Map(artistRows.map((row) => [row.externalId, row.name]));
  const spotifyUrlByExternalId = new Map(
    spotifyRows.map((row) => [row.externalId, row.providerUrl]),
  );
  const sourceReleases: ShowcaseSourceRelease[] = [];
  let invalidAppleReleaseCount = 0;

  for (const row of appleReleaseRows) {
    const candidates = candidatesByReleaseId.get(row.appleProviderReleaseId) ?? [];
    const firstCandidate = candidates[0];
    const artistName =
      firstCandidate === undefined
        ? undefined
        : artistNameByExternalId.get(firstCandidate.artistExternalId);
    const appleMetadata =
      firstCandidate === undefined ? undefined : appleCandidateMetadata(firstCandidate.rawPayload);
    if (firstCandidate === undefined || artistName === undefined || appleMetadata === undefined) {
      invalidAppleReleaseCount += 1;
      continue;
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

    sourceReleases.push({
      appleMusicUrl: row.appleMusicUrl,
      appleProviderReleaseId: row.appleProviderReleaseId,
      artistName,
      firstDiscoveredAt: firstCandidate.firstSeenAt,
      releaseDate: firstCandidate.releaseDate,
      releaseType: appleMetadata.releaseType,
      ...(spotifyUrl === undefined ? {} : { spotifyUrl }),
      title: appleMetadata.releaseTitle,
      tracks: sourceTracks,
    });
  }

  return { invalidAppleReleaseCount, releases: sourceReleases };
}

export function buildShowcasePublicCatalog(
  source: ShowcasePublicationSource,
  generatedAt = new Date(),
): ShowcasePublicationResult {
  const releases = source.releases
    .flatMap((release) => {
      const appleMusicUrl = validatedProviderUrl(release.appleMusicUrl, "music.apple.com");
      if (appleMusicUrl === undefined) return [];
      const spotifyUrl =
        release.spotifyUrl === undefined
          ? undefined
          : validatedProviderUrl(release.spotifyUrl, "open.spotify.com", "/album/");
      const identityHash = stableHash(release.appleProviderReleaseId);
      const publicRelease = {
        publicId: `release_${identityHash.slice(0, 20)}`,
        slug: `${slugify(`${release.artistName}-${release.title}`)}-${identityHash.slice(0, 8)}`,
        artistName: release.artistName.trim(),
        title: release.title.trim(),
        type: publicTypeByCanonicalType[release.releaseType] ?? "Other",
        status: release.releaseDate > isoDate(generatedAt) ? "upcoming" : "released",
        releaseDate: release.releaseDate,
        firstDiscoveredDate: isoDate(release.firstDiscoveredAt),
        genres: [],
        tracks: release.tracks.map((track) => ({
          discNumber: track.discNumber,
          position: track.position,
          title: track.title.trim(),
        })),
        links: {
          appleMusic: appleMusicUrl,
          ...(spotifyUrl === undefined ? {} : { spotify: spotifyUrl }),
        },
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
    contractVersion: "showcase-public-v1",
    generatedAt: generatedAt.toISOString(),
    releases,
  });
  const withSpotifyCount = releases.filter((release) => release.links.spotify !== undefined).length;
  return {
    catalog,
    invalidAppleReleaseCount:
      source.invalidAppleReleaseCount + source.releases.length - releases.length,
    releaseCount: releases.length,
    withSpotifyCount,
    withoutSpotifyCount: releases.length - withSpotifyCount,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const value = key(row);
    grouped.set(value, [...(grouped.get(value) ?? []), row]);
  }
  return grouped;
}

function stableHash(value: string): string {
  return createHash("sha256").update(`showcase-release-v1:${value}`).digest("hex");
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
  return slug || "release";
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function appleCandidateMetadata(
  value: unknown,
): { releaseTitle: string; releaseType: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.releaseTitle !== "string" || typeof record.releaseType !== "string") {
    return undefined;
  }
  return { releaseTitle: record.releaseTitle, releaseType: record.releaseType };
}

function validatedProviderUrl(
  value: string,
  expectedHost: string,
  requiredPathPrefix?: string,
): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== expectedHost ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    if (requiredPathPrefix !== undefined && !url.pathname.startsWith(requiredPathPrefix)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}
