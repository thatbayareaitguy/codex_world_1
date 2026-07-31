import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { normalizeText } from "@radar/core";
import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import {
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
  scopedAppleMusicRecentGroundTruth,
} from "./apple-music-recent";
import type { ItunesPilotGroundTruthRelease, ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export const appleMusicRecentValidationConfirmation = "APPLE_RECENT_MVP_VALIDATION_25";
export const appleMusicRecentValidationSeed = "apple-recent-validation-25-v1";

export type AppleMusicRecentValidationCategory =
  "identity_catalog_stress" | "negative" | "positive";

export interface AppleMusicRecentValidationManifest {
  artists: Array<{
    frozenReleaseCount: number;
    name: string;
    selectionCategory: AppleMusicRecentValidationCategory;
  }>;
  evaluationAsOf: typeof appleMusicRecentEvaluationTime;
  seed: typeof appleMusicRecentValidationSeed;
  snapshotHash: string;
  version: 1;
}

export async function readAppleMusicRecentValidationManifest(
  path: string,
): Promise<AppleMusicRecentValidationManifest> {
  return JSON.parse(await readFile(path, "utf8")) as AppleMusicRecentValidationManifest;
}

export function deriveAppleMusicRecentValidationManifest(
  snapshot: ItunesPilotSnapshot,
): AppleMusicRecentValidationManifest {
  validateAppleMusicPilotSnapshot(snapshot);
  const excluded = new Set<string>(appleMusicRecentSample);
  const evaluationEnd = new Date(appleMusicRecentEvaluationTime);
  const eligible = snapshot.artists
    .filter((source) => !excluded.has(source.canonicalName))
    .map((source) => {
      const releases = scopedAppleMusicRecentGroundTruth(snapshot, source, evaluationEnd);
      return {
        entry: {
          canonicalArtistId: source.canonicalArtistId,
          name: source.canonicalName,
        },
        releases,
        stableOrder: stableOrder(source.canonicalName),
        stress: source.cohortReason === "identity_stress",
      };
    });
  if (eligible.length !== 40) {
    throw new Error(
      `Validation derivation requires exactly 40 remaining artists, found ${eligible.length}.`,
    );
  }

  const ordinary = eligible.filter((value) => !value.stress);
  const positive = selectPositiveCoverage(
    ordinary.filter((value) => value.releases.length > 0),
    10,
  );
  const negative = ordinary
    .filter((value) => value.releases.length === 0)
    .sort(compareStable)
    .slice(0, 10);
  const selectedNames = new Set([...positive, ...negative].map((value) => value.entry.name));
  const stressPool = eligible.filter(
    (value) => value.stress && !selectedNames.has(value.entry.name),
  );
  const stress = [
    ...stressPool
      .filter((value) => value.releases.length > 0)
      .sort(compareStable)
      .slice(0, 2),
    ...stressPool
      .filter((value) => value.releases.length === 0)
      .sort(compareStable)
      .slice(0, 3),
  ];
  if (positive.length !== 10 || negative.length !== 10 || stress.length !== 5) {
    throw new Error("The frozen snapshot cannot supply the required 10/10/5 validation strata.");
  }

  return {
    artists: [
      ...positive.map((value) => manifestArtist(value, "positive")),
      ...negative.map((value) => manifestArtist(value, "negative")),
      ...stress.map((value) => manifestArtist(value, "identity_catalog_stress")),
    ],
    evaluationAsOf: appleMusicRecentEvaluationTime,
    seed: appleMusicRecentValidationSeed,
    snapshotHash: snapshot.snapshotHash,
    version: 1,
  };
}

export function validateAppleMusicRecentValidationManifest(
  manifest: AppleMusicRecentValidationManifest,
  snapshot: ItunesPilotSnapshot,
): AppleMusicRecentValidationManifest {
  const derived = deriveAppleMusicRecentValidationManifest(snapshot);
  if (JSON.stringify(manifest) !== JSON.stringify(derived)) {
    throw new Error(
      "Validation manifest does not exactly match the deterministic frozen-snapshot derivation.",
    );
  }
  return manifest;
}

function selectPositiveCoverage(
  pool: Array<ValidationCandidate>,
  count: number,
): Array<ValidationCandidate> {
  const remaining = [...pool];
  const selected: ValidationCandidate[] = [];
  const covered = new Set<string>();
  while (selected.length < count && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftGain = releaseCategories(left.releases).filter(
        (value) => !covered.has(value),
      ).length;
      const rightGain = releaseCategories(right.releases).filter(
        (value) => !covered.has(value),
      ).length;
      return rightGain - leftGain || compareStable(left, right);
    });
    const next = remaining.shift()!;
    selected.push(next);
    for (const category of releaseCategories(next.releases)) covered.add(category);
  }
  return selected;
}

interface ValidationCandidate {
  entry: { name: string };
  releases: ItunesPilotGroundTruthRelease[];
  stableOrder: string;
}

function manifestArtist(
  value: ValidationCandidate,
  selectionCategory: AppleMusicRecentValidationCategory,
) {
  return {
    frozenReleaseCount: value.releases.length,
    name: value.entry.name,
    selectionCategory,
  };
}

function compareStable(left: ValidationCandidate, right: ValidationCandidate): number {
  return left.stableOrder.localeCompare(right.stableOrder);
}

function stableOrder(name: string): string {
  return createHash("sha256")
    .update(`${appleMusicRecentValidationSeed}:${normalizeText(name)}`)
    .digest("hex");
}

function releaseCategories(releases: ItunesPilotGroundTruthRelease[]): string[] {
  return [
    ...new Set(
      releases.map((release) => {
        if (release.releaseType === "remix") return "remix_of";
        if (release.releaseType === "feature") return "remix_by";
        return release.releaseType;
      }),
    ),
  ];
}
