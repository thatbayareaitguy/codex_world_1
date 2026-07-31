import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeText } from "@radar/core";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export interface AppleMusicIdentityBootstrapArtifact {
  artifactHash: string;
  artists: AppleMusicIdentityBootstrapArtist[];
  evidenceAsOf: string;
  snapshotHash: string;
  version: 1;
}

export interface AppleMusicIdentityBootstrapArtist {
  candidateArtistId?: string;
  candidateEvidenceArtistIds?: string[];
  candidateEvidenceSource?: string;
  canonicalArtistName: string;
  evidenceSource?: string;
  frozenReleaseCount: number;
  plausibleExactNameCandidates: number;
}

export interface AppleMusicIdentityBootstrapPlan {
  artifactHash: string;
  artistsRequiringCandidateCatalogEvidence: string[];
  artistsRequiringIdConfirmation: string[];
  artistsRequiringZeroRequests: string[];
  candidateEvidenceEndpoint: "/v1/catalog/us/artists/<candidate_id>/view/top-songs";
  catalogEvidenceRequests: number;
  confirmationRequests: number;
  discoveryProfileExecuted: false;
  idConfirmationEndpoint: "/v1/catalog/us/artists/<seed_id>";
  maximumCandidateCountPerArtist: 2;
  maximumRuntimeMs: 60_000;
  minimumPacedRuntimeMs: number;
  mode: "mapping_bootstrap_plan";
  networkRequestsStarted: 0;
  proposedRequestCeiling: 25;
  requestForecast: number;
  retryRequests: 0;
  seedIsConfirmation: false;
  writes: 0;
}

export async function readAppleMusicIdentityBootstrapArtifact(
  path: string,
): Promise<AppleMusicIdentityBootstrapArtifact> {
  return JSON.parse(await readFile(path, "utf8")) as AppleMusicIdentityBootstrapArtifact;
}

export function validateAppleMusicIdentityBootstrapArtifact(
  artifact: AppleMusicIdentityBootstrapArtifact,
  snapshot: ItunesPilotSnapshot,
): AppleMusicIdentityBootstrapArtifact {
  if (artifact.version !== 1) throw new Error("Unsupported Apple identity bootstrap version.");
  if (artifact.snapshotHash !== snapshot.snapshotHash) {
    throw new Error("Apple identity bootstrap snapshot hash does not match.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(artifact.evidenceAsOf)) {
    throw new Error("Apple identity bootstrap evidence date is invalid.");
  }
  if (computeAppleMusicIdentityBootstrapHash(artifact) !== artifact.artifactHash) {
    throw new Error("Apple identity bootstrap artifact hash does not match.");
  }
  const snapshotArtists = new Map(
    snapshot.artists.map((artist) => [normalizeText(artist.canonicalName), artist]),
  );
  const seen = new Set<string>();
  for (const artist of artifact.artists) {
    const normalizedName = normalizeText(artist.canonicalArtistName);
    if (seen.has(normalizedName)) {
      throw new Error(`Duplicate Apple identity seed for ${artist.canonicalArtistName}.`);
    }
    seen.add(normalizedName);
    const snapshotArtist = snapshotArtists.get(normalizedName);
    if (!snapshotArtist || snapshotArtist.canonicalName !== artist.canonicalArtistName) {
      throw new Error(`Apple identity seed artist ${artist.canonicalArtistName} is not canonical.`);
    }
    const frozenReleaseCount = snapshot.groundTruthReleases.filter(
      (release) => release.canonicalArtistId === snapshotArtist.canonicalArtistId,
    ).length;
    if (frozenReleaseCount !== artist.frozenReleaseCount) {
      throw new Error(
        `Apple identity seed release count differs for ${artist.canonicalArtistName}.`,
      );
    }
    if (
      !Number.isInteger(artist.plausibleExactNameCandidates) ||
      artist.plausibleExactNameCandidates < 2
    ) {
      throw new Error("Bootstrap entries must retain an ambiguous exact-name candidate count.");
    }
    if (artist.candidateArtistId && !/^\d+$/.test(artist.candidateArtistId)) {
      throw new Error("Apple identity seed candidate IDs must be public numeric catalog IDs.");
    }
    if (Boolean(artist.candidateArtistId) !== Boolean(artist.evidenceSource)) {
      throw new Error("Apple identity seed candidates require an evidence source.");
    }
    if (
      Boolean(artist.candidateEvidenceArtistIds) !== Boolean(artist.candidateEvidenceSource) ||
      (artist.candidateEvidenceArtistIds?.length ?? 0) > 2 ||
      artist.candidateEvidenceArtistIds?.some((id) => !/^\d+$/.test(id))
    ) {
      throw new Error("Apple identity evidence candidates require at most two public catalog IDs.");
    }
    if (
      artist.candidateEvidenceArtistIds &&
      new Set(artist.candidateEvidenceArtistIds).size !== artist.candidateEvidenceArtistIds.length
    ) {
      throw new Error("Apple identity evidence candidate IDs must be unique.");
    }
    if (!artist.candidateArtistId && artist.candidateEvidenceArtistIds?.length !== 2) {
      throw new Error("Unseeded bootstrap artists require exactly two evidence candidates.");
    }
  }
  return artifact;
}

export function computeAppleMusicIdentityBootstrapHash(
  artifact: Omit<AppleMusicIdentityBootstrapArtifact, "artifactHash"> &
    Partial<Pick<AppleMusicIdentityBootstrapArtifact, "artifactHash">>,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: artifact.version,
        snapshotHash: artifact.snapshotHash,
        evidenceAsOf: artifact.evidenceAsOf,
        artists: artifact.artists,
      }),
    )
    .digest("hex");
}

export function createAppleMusicIdentityBootstrapPlan(
  artifact: AppleMusicIdentityBootstrapArtifact,
  snapshot: ItunesPilotSnapshot,
): AppleMusicIdentityBootstrapPlan {
  const valid = validateAppleMusicIdentityBootstrapArtifact(artifact, snapshot);
  const artistsRequiringIdConfirmation = valid.artists
    .filter((artist) => artist.candidateArtistId)
    .map((artist) => artist.canonicalArtistName);
  const artistsRequiringCandidateCatalogEvidence = valid.artists
    .filter((artist) => !artist.candidateArtistId)
    .map((artist) => artist.canonicalArtistName);
  const confirmationRequests = artistsRequiringIdConfirmation.length;
  const catalogEvidenceRequests = valid.artists
    .filter((artist) => !artist.candidateArtistId)
    .reduce((total, artist) => total + (artist.candidateEvidenceArtistIds?.length ?? 0), 0);
  const requestForecast = confirmationRequests + catalogEvidenceRequests;
  return {
    artifactHash: valid.artifactHash,
    artistsRequiringCandidateCatalogEvidence,
    artistsRequiringIdConfirmation,
    artistsRequiringZeroRequests: [],
    candidateEvidenceEndpoint: "/v1/catalog/us/artists/<candidate_id>/view/top-songs",
    catalogEvidenceRequests,
    confirmationRequests,
    discoveryProfileExecuted: false,
    idConfirmationEndpoint: "/v1/catalog/us/artists/<seed_id>",
    maximumCandidateCountPerArtist: 2,
    maximumRuntimeMs: 60_000,
    minimumPacedRuntimeMs: Math.max(0, requestForecast - 1) * 1_100,
    mode: "mapping_bootstrap_plan",
    networkRequestsStarted: 0,
    proposedRequestCeiling: 25,
    requestForecast,
    retryRequests: 0,
    seedIsConfirmation: false,
    writes: 0,
  };
}
