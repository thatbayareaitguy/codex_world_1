import { readFile } from "node:fs/promises";
import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import {
  appleMusicRecentEvaluationTime,
  scopedAppleMusicRecentGroundTruth,
} from "./apple-music-recent";
import type { ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export const appleMusicRecentSeedDiscoveryConfirmation = "APPLE_RECENT_SEED_DISCOVERY_5";
export const appleMusicRecentSeedDiscoverySeed = "apple-recent-seed-discovery-5-v1";
export const appleMusicRecentSeedDiscoveryArtists = [
  "ZHU",
  "Don Diablo",
  "SISTO",
  "William Black",
  "YUSSI",
] as const;

export interface AppleMusicRecentSeedDiscoveryManifest {
  artists: Array<{
    frozenReleaseCount: number;
    name: (typeof appleMusicRecentSeedDiscoveryArtists)[number];
    selectionReason: "newly_confirmed_public_id_seed";
  }>;
  evaluationAsOf: typeof appleMusicRecentEvaluationTime;
  seed: typeof appleMusicRecentSeedDiscoverySeed;
  snapshotHash: string;
  version: 1;
}

export async function readAppleMusicRecentSeedDiscoveryManifest(
  path: string,
): Promise<AppleMusicRecentSeedDiscoveryManifest> {
  return JSON.parse(await readFile(path, "utf8")) as AppleMusicRecentSeedDiscoveryManifest;
}

export function deriveAppleMusicRecentSeedDiscoveryManifest(
  snapshot: ItunesPilotSnapshot,
): AppleMusicRecentSeedDiscoveryManifest {
  const evaluationEnd = new Date(appleMusicRecentEvaluationTime);
  return {
    artists: appleMusicRecentSeedDiscoveryArtists.map((name) => {
      const artist = snapshot.artists.find((candidate) => candidate.canonicalName === name);
      if (!artist) throw new Error(`Seed-discovery artist ${name} is missing from the snapshot.`);
      return {
        frozenReleaseCount: scopedAppleMusicRecentGroundTruth(snapshot, artist, evaluationEnd)
          .length,
        name,
        selectionReason: "newly_confirmed_public_id_seed" as const,
      };
    }),
    evaluationAsOf: appleMusicRecentEvaluationTime,
    seed: appleMusicRecentSeedDiscoverySeed,
    snapshotHash: snapshot.snapshotHash,
    version: 1,
  };
}

export function validateAppleMusicRecentSeedDiscoveryManifest(
  manifest: AppleMusicRecentSeedDiscoveryManifest,
  snapshot: ItunesPilotSnapshot,
  validateSnapshot: typeof validateAppleMusicPilotSnapshot = validateAppleMusicPilotSnapshot,
): AppleMusicRecentSeedDiscoveryManifest {
  validateSnapshot(snapshot);
  const derived = deriveAppleMusicRecentSeedDiscoveryManifest(snapshot);
  if (JSON.stringify(manifest) !== JSON.stringify(derived)) {
    throw new Error(
      "Seed-discovery manifest does not exactly match the frozen snapshot and five-artist scope.",
    );
  }
  const releaseCount = manifest.artists.reduce(
    (total, artist) => total + artist.frozenReleaseCount,
    0,
  );
  if (releaseCount !== 8) {
    throw new Error(`Seed-discovery manifest requires exactly eight frozen releases.`);
  }
  return manifest;
}
