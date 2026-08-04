import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export const appleMusicIdentitySeedSchemaVersion = 1;
export const appleMusicIdentitySeedWatchlistCount = 593;
export const appleMusicIdentitySeedApprovedWatchlistHash =
  "6006f18385e161c1acee5340dcb23ac46688f21b14e3b0e1de85e87e4ed586b0";
export const appleMusicIdentitySeedApprovedArtifactHash =
  "0243f3d28d6cb51ec0474da7486f8d73c66fd13398d17601d021c876ee0f8660";
export const appleMusicIdentitySeedExpectedClassifications = {
  ambiguous_seed: 272,
  evidence_supported_seed: 13,
  high_confidence_seed: 307,
  manual_review_required: 1,
  no_candidate: 0,
} as const;

const classificationSchema = z.enum([
  "high_confidence_seed",
  "evidence_supported_seed",
  "ambiguous_seed",
  "no_candidate",
  "manual_review_required",
]);
const confidenceSchema = z.enum(["high", "evidence_supported", "ambiguous", "unresolved"]);
const matchStatusSchema = z.enum(["none", "unique", "multiple"]);
const numericCandidateIdSchema = z.string().regex(/^\d{1,30}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const isoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp);
const nonemptyStringSchema = z.string().trim().min(1);

const entrySchema = z
  .object({
    aliasMatchStatus: matchStatusSchema,
    aliases: z.array(nonemptyStringSchema),
    alternateCandidateIds: z.array(numericCandidateIdSchema).max(10),
    candidateArtistId: numericCandidateIdSchema.optional(),
    canonicalArtistName: nonemptyStringSchema,
    classification: classificationSchema,
    confidence: confidenceSchema,
    conflictingEvidenceCount: z.number().int().nonnegative(),
    evidenceSources: z.array(nonemptyStringSchema),
    evidenceTimestamp: isoTimestampSchema,
    exactNameMatchStatus: matchStatusSchema,
    manualReviewReason: nonemptyStringSchema.optional(),
    plausibleCandidateCount: z.number().int().nonnegative(),
    publicArtistPageUrl: z.string().url().refine(isSafePublicArtistUrl).optional(),
    releaseTitleOverlapCount: z.number().int().nonnegative(),
    trackTitleOverlapCount: z.number().int().nonnegative(),
    watchedArtistId: z.string().uuid(),
  })
  .strict();

const classificationCountsSchema = z
  .object({
    ambiguous_seed: z.number().int().nonnegative(),
    evidence_supported_seed: z.number().int().nonnegative(),
    high_confidence_seed: z.number().int().nonnegative(),
    manual_review_required: z.number().int().nonnegative(),
    no_candidate: z.number().int().nonnegative(),
  })
  .strict();

const artifactSchema = z
  .object({
    artifactSelfHash: sha256Schema,
    canonicalWatchlistCount: z.number().int().nonnegative(),
    classificationCounts: classificationCountsSchema,
    createdAt: isoTimestampSchema,
    entries: z.array(entrySchema),
    evidenceCutoffDate: isoTimestampSchema,
    inputWatchlistHash: sha256Schema,
    itunesRequestCountUsedForExport: z.number().int().nonnegative(),
    schemaVersion: z.literal(appleMusicIdentitySeedSchemaVersion),
    sourceBranch: z.literal("codex/itunes-discovery"),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    storefront: z.literal("us"),
  })
  .strict();

export type AppleMusicIdentitySeedArtifact = z.infer<typeof artifactSchema>;
export type AppleMusicIdentitySeedClassification = z.infer<typeof classificationSchema>;

export interface AppleMusicIdentitySeedPlan {
  artifactSelfHash: string;
  automaticConfirmations: 0;
  candidateBearingArtistCount: number;
  candidateIdCount: number;
  candidatePolicy: "unconfirmed_candidate_until_independent_apple_validation";
  canonicalWatchlistCount: 593;
  classificationCounts: typeof appleMusicIdentitySeedExpectedClassifications;
  credentialsAccessed: false;
  databaseReads: 0;
  databaseWrites: 0;
  futureLiveValidationAuthorized: false;
  futureRequestForecast: "requires_separately_bounded_milestone";
  inputWatchlistHash: string;
  mode: "apple_identity_seed_plan";
  networkRequestsStarted: 0;
  providerClientInitialized: false;
  schemaVersion: 1;
  sourceBranch: "codex/itunes-discovery";
  sourceCommit: string;
  storefront: "us";
  tokenGenerated: false;
  unconfirmedArtistCount: 593;
  withoutCandidateCount: 1;
}

export async function readAppleMusicIdentitySeedArtifact(
  path: string,
): Promise<AppleMusicIdentitySeedArtifact> {
  return parseAppleMusicIdentitySeedArtifact(JSON.parse(await readFile(path, "utf8")) as unknown);
}

export function parseAppleMusicIdentitySeedArtifact(
  value: unknown,
): AppleMusicIdentitySeedArtifact {
  const artifact = artifactSchema.parse(value);
  if (artifact.canonicalWatchlistCount !== artifact.entries.length) {
    throw new Error("Apple identity-seed watchlist count does not match its entries.");
  }
  if (
    new Set(artifact.entries.map((entry) => entry.watchedArtistId)).size !== artifact.entries.length
  ) {
    throw new Error("Apple identity-seed entries contain duplicate watched-artist identities.");
  }
  for (const entry of artifact.entries) validateCandidateEntry(entry);
  const actualCounts = countClassifications(artifact.entries);
  if (canonicalJson(actualCounts) !== canonicalJson(artifact.classificationCounts)) {
    throw new Error("Apple identity-seed classification totals do not match its entries.");
  }
  if (computeAppleMusicIdentitySeedWatchlistHash(artifact) !== artifact.inputWatchlistHash) {
    throw new Error("Apple identity-seed watchlist hash validation failed.");
  }
  if (computeAppleMusicIdentitySeedArtifactHash(artifact) !== artifact.artifactSelfHash) {
    throw new Error("Apple identity-seed artifact self-hash validation failed.");
  }
  return artifact;
}

export function createAppleMusicIdentitySeedPlan(
  artifact: AppleMusicIdentitySeedArtifact,
): AppleMusicIdentitySeedPlan {
  const valid = parseAppleMusicIdentitySeedArtifact(artifact);
  if (valid.canonicalWatchlistCount !== appleMusicIdentitySeedWatchlistCount) {
    throw new Error("Apple identity-seed plan requires exactly 593 artists.");
  }
  if (
    canonicalJson(valid.classificationCounts) !==
    canonicalJson(appleMusicIdentitySeedExpectedClassifications)
  ) {
    throw new Error(
      "Apple identity-seed plan classification totals differ from the approved scope.",
    );
  }
  const candidateIdCount = valid.entries.reduce(
    (total, entry) =>
      total + (entry.candidateArtistId ? 1 : 0) + entry.alternateCandidateIds.length,
    0,
  );
  const candidateBearingArtistCount = valid.entries.filter(
    (entry) => Boolean(entry.candidateArtistId) || entry.alternateCandidateIds.length > 0,
  ).length;
  const withoutCandidateCount = valid.entries.length - candidateBearingArtistCount;
  if (withoutCandidateCount !== 1) {
    throw new Error("Apple identity-seed plan requires exactly one artist without a candidate.");
  }
  return {
    artifactSelfHash: valid.artifactSelfHash,
    automaticConfirmations: 0,
    candidateBearingArtistCount,
    candidateIdCount,
    candidatePolicy: "unconfirmed_candidate_until_independent_apple_validation",
    canonicalWatchlistCount: appleMusicIdentitySeedWatchlistCount,
    classificationCounts: { ...appleMusicIdentitySeedExpectedClassifications },
    credentialsAccessed: false,
    databaseReads: 0,
    databaseWrites: 0,
    futureLiveValidationAuthorized: false,
    futureRequestForecast: "requires_separately_bounded_milestone",
    inputWatchlistHash: valid.inputWatchlistHash,
    mode: "apple_identity_seed_plan",
    networkRequestsStarted: 0,
    providerClientInitialized: false,
    schemaVersion: appleMusicIdentitySeedSchemaVersion,
    sourceBranch: valid.sourceBranch,
    sourceCommit: valid.sourceCommit,
    storefront: valid.storefront,
    tokenGenerated: false,
    unconfirmedArtistCount: appleMusicIdentitySeedWatchlistCount,
    withoutCandidateCount,
  };
}

export function validateApprovedAppleMusicIdentitySeedArtifact(
  artifact: AppleMusicIdentitySeedArtifact,
): AppleMusicIdentitySeedArtifact {
  const valid = parseAppleMusicIdentitySeedArtifact(artifact);
  if (valid.inputWatchlistHash !== appleMusicIdentitySeedApprovedWatchlistHash) {
    throw new Error("Apple identity-seed artifact has an unapproved watchlist hash.");
  }
  if (valid.artifactSelfHash !== appleMusicIdentitySeedApprovedArtifactHash) {
    throw new Error("Apple identity-seed artifact has an unapproved self-hash.");
  }
  const selectedIds = valid.entries.flatMap((entry) =>
    entry.candidateArtistId ? [entry.candidateArtistId] : [],
  );
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("Apple identity-seed selected candidates must be unique across artists.");
  }
  return valid;
}

export function computeAppleMusicIdentitySeedWatchlistHash(
  artifact: Pick<AppleMusicIdentitySeedArtifact, "entries">,
): string {
  return sha256(
    canonicalJson(
      artifact.entries.map((entry) => ({
        aliases: entry.aliases,
        canonicalArtistName: entry.canonicalArtistName,
        watchedArtistId: entry.watchedArtistId,
      })),
    ),
  );
}

export function computeAppleMusicIdentitySeedArtifactHash(
  artifact: AppleMusicIdentitySeedArtifact,
): string {
  const content: Record<string, unknown> = { ...artifact };
  Reflect.deleteProperty(content, "artifactSelfHash");
  return sha256(canonicalJson(content));
}

function validateCandidateEntry(entry: AppleMusicIdentitySeedArtifact["entries"][number]): void {
  const candidateIds = [
    ...(entry.candidateArtistId ? [entry.candidateArtistId] : []),
    ...entry.alternateCandidateIds,
  ];
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error("Apple identity-seed candidate IDs must be unique within each artist.");
  }
  const expectedConfidence = {
    ambiguous_seed: "ambiguous",
    evidence_supported_seed: "evidence_supported",
    high_confidence_seed: "high",
    manual_review_required: "unresolved",
    no_candidate: "unresolved",
  } as const;
  if (entry.confidence !== expectedConfidence[entry.classification]) {
    throw new Error("Apple identity-seed classification and confidence disagree.");
  }
  if (
    (entry.classification === "high_confidence_seed" ||
      entry.classification === "evidence_supported_seed") &&
    !entry.candidateArtistId
  ) {
    throw new Error("Apple identity-seed selected candidate classification lacks a candidate.");
  }
  if (entry.classification === "ambiguous_seed" && entry.alternateCandidateIds.length < 2) {
    throw new Error("Apple ambiguous identity seeds require at least two candidate IDs.");
  }
  if (
    (entry.classification === "no_candidate" ||
      entry.classification === "manual_review_required") &&
    candidateIds.length > 0
  ) {
    throw new Error("Apple unresolved identity-seed entries cannot contain candidate IDs.");
  }
}

function countClassifications(
  entries: AppleMusicIdentitySeedArtifact["entries"],
): Record<AppleMusicIdentitySeedClassification, number> {
  const counts: Record<AppleMusicIdentitySeedClassification, number> = {
    ambiguous_seed: 0,
    evidence_supported_seed: 0,
    high_confidence_seed: 0,
    manual_review_required: 0,
    no_candidate: 0,
  };
  for (const entry of entries) counts[entry.classification] += 1;
  return counts;
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafePublicArtistUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (url.hostname === "music.apple.com" ||
        url.hostname === "itunes.apple.com" ||
        url.hostname.endsWith(".itunes.apple.com"))
    );
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonical(value));
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareText)
      .map((key) => [key, sortCanonical(record[key])]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
