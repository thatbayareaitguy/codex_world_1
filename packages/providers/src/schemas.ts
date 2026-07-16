import { feedStates, providerNames, releaseTypes } from "@radar/core";
import { z } from "zod";

const artistCreditSchema = z.object({
  name: z.string().min(1),
  canonicalArtistId: z.string().min(1).optional(),
  role: z.enum(["primary", "featured", "remixer", "producer"]),
});

export const trackCandidateSchema = z.object({
  provider: z.enum(providerNames),
  externalReleaseId: z.string().min(1),
  externalTrackId: z.string().min(1),
  sourceLabel: z.string().min(1),
  artistExternalId: z.string().min(1),
  artistName: z.string().min(1),
  title: z.string().min(1),
  releaseTitle: z.string().min(1),
  releaseType: z.enum(releaseTypes),
  releaseDate: z.iso.date(),
  releaseDatePrecision: z.enum(["day", "month", "year"]),
  firstSeenAt: z.iso.datetime(),
  credits: z.array(artistCreditSchema).min(1),
  durationMs: z.number().int().positive().optional(),
  isrc: z.string().min(5).optional(),
  upc: z.string().min(5).optional(),
  ean: z.string().min(5).optional(),
  discNumber: z.number().int().positive().optional(),
  trackNumber: z.number().int().positive().optional(),
  musicbrainzRecordingId: z.string().uuid().optional(),
  musicbrainzReleaseGroupId: z.string().uuid().optional(),
  version: z.string().min(1).optional(),
  region: z.string().length(2),
  availability: z.enum(["playable", "preview", "blocked", "unavailable"]),
  providerUrl: z.url(),
  evidenceUrl: z.url(),
  evidenceType: z.string().min(1),
  payloadHash: z.string().min(8),
  isUpcoming: z.boolean().optional(),
});

export const mockResponseSchema = z.object({
  fixtureVersion: z.literal(1),
  candidates: z.array(trackCandidateSchema),
  nextCursor: z.string().optional(),
});

export const feedStateSchema = z.enum(feedStates);
