import { z } from "zod";

import { showcaseGenreSlugs } from "./genre-taxonomy";
import type { PublicCatalogSnapshot } from "./public-catalog";

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

const publicArtistCreditSchema = z
  .object({
    name: z.string().trim().min(1).max(500),
    artistSlug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
      .optional(),
  })
  .strict();

const publicTrackSchema = z
  .object({
    discNumber: z.number().int().positive(),
    position: z.number().int().positive(),
    title: z.string().trim().min(1).max(500),
  })
  .strict();

export const publicCatalogSnapshotSchema = z
  .object({
    contractVersion: z.literal("showcase-public-v3"),
    generatedAt: z.iso.datetime({ offset: true }),
    genres: z.array(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          slug: z.enum(showcaseGenreSlugs),
        })
        .strict(),
    ),
    artists: z.array(
      z
        .object({
          publicId: z.string().regex(/^artist_[a-f0-9]{20}$/u),
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          name: z.string().trim().min(1).max(500),
          genreSlugs: z.array(z.enum(showcaseGenreSlugs)).max(showcaseGenreSlugs.length),
          labelAssociations: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
          links: publicLinksSchema,
          artworkTone: z.enum(artworkTones),
        })
        .strict(),
    ),
    releases: z.array(
      z
        .object({
          publicId: z.string().regex(/^release_[a-f0-9]{20}$/u),
          slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
          title: z.string().trim().min(1).max(500),
          artistCredits: z.array(publicArtistCreditSchema).min(1).max(50),
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
        .strict(),
    ),
  })
  .strict();

export function parsePublicCatalogSnapshot(value: unknown): PublicCatalogSnapshot {
  return publicCatalogSnapshotSchema.parse(value) as PublicCatalogSnapshot;
}
