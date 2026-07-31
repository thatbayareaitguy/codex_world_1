import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import {
  appleMusicIdentityBootstrapConfirmation,
  createAppleMusicIdentityBootstrapPlan,
  readAppleMusicIdentityBootstrapArtifact,
  validateAppleMusicIdentityBootstrapArtifact,
  validateAppleMusicIdentityBootstrapSources,
  type AppleMusicIdentityBootstrapPlan,
} from "./apple-music-identity-bootstrap";
import {
  appleMusicRecentConfirmation,
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
} from "./apple-music-recent";
import {
  appleMusicRecentValidationConfirmation,
  readAppleMusicRecentValidationManifest,
  validateAppleMusicRecentValidationManifest,
} from "./apple-music-recent-validation";
import { readItunesPilotSnapshot, type ItunesPilotSnapshot } from "./itunes-pilot-snapshot";

export const appleMusicRecentProfiles = ["current", "optimized_four_source"] as const;
export type AppleMusicRecentProfile = (typeof appleMusicRecentProfiles)[number];

export interface AppleMusicRecentPlan {
  artists: string[];
  evaluationAsOf: string;
  forecast: {
    armARequests: number;
    armBRequests: number;
    armCRequests: number;
    freshSearchRequests: number;
    freshTopSongsRequests: number;
    mappingRequests: number;
    recurringProfileRequests: number;
    requestBudget: 25 | 100 | 175;
    reusedHistoricalRequests: number;
    retryReserve: number;
    targetedDetailRequests: number;
    totalRequests: number;
  };
  limits: {
    concurrency: 1;
    maximumRuntimeMs: 300_000 | 900_000 | 1_200_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 25 | 100 | 175;
  };
  mode: "plan";
  networkRequestsStarted: 0;
  noPagination: true;
  profile: AppleMusicRecentProfile;
  scope: "sample" | "validation_25";
  snapshotHash: string;
  storefront: "us";
  writes: 0;
}

export type AppleMusicRecentCommand =
  | {
      identitySeedsPath: string;
      mode: "mapping_bootstrap_plan";
      snapshotPath: string;
    }
  | {
      confirmation: typeof appleMusicIdentityBootstrapConfirmation;
      identitySeedsPath: string;
      mode: "mapping_bootstrap_live";
      snapshotPath: string;
    }
  | {
      cohortManifestPath?: string;
      mode: "plan";
      profile: AppleMusicRecentProfile;
      scope: "sample" | "validation_25";
      snapshotPath: string;
    }
  | {
      cohortManifestPath?: string;
      confirmation:
        typeof appleMusicRecentConfirmation | typeof appleMusicRecentValidationConfirmation;
      evaluationAsOf: typeof appleMusicRecentEvaluationTime;
      mode: "execute_live";
      profile: AppleMusicRecentProfile;
      scope: "sample" | "validation_25";
      snapshotPath: string;
    };

export function parseAppleMusicRecentCommand(args: string[]): AppleMusicRecentCommand {
  const values = args.filter((value) => value !== "--");
  const plan = values.includes("--plan");
  const live = values.includes("--execute-live");
  if (plan === live) throw new Error("Choose exactly one of --plan or --execute-live.");
  const sample = values.includes("--sample");
  const cohortManifestPath = optionalOption(values, "--cohort-manifest");
  const mappingBootstrap = values.includes("--mapping-bootstrap");
  const identitySeedsPath = optionalOption(values, "--identity-seeds");
  if (mappingBootstrap) {
    if (sample || cohortManifestPath) {
      throw new Error("Mapping bootstrap does not accept a release-discovery cohort.");
    }
    if (!identitySeedsPath || identitySeedsPath.startsWith("--")) {
      throw new Error("Mapping bootstrap requires --identity-seeds.");
    }
    const snapshotPath = requiredOption(values, "--snapshot");
    const confirmation = optionalOption(values, "--confirm-live");
    const optionNames = new Set([
      "--plan",
      "--execute-live",
      "--confirm-live",
      "--mapping-bootstrap",
      "--identity-seeds",
      "--snapshot",
    ]);
    const optionValues = new Set(
      [identitySeedsPath, snapshotPath, confirmation].filter((value): value is string =>
        Boolean(value),
      ),
    );
    const unexpected = values.find((value) => !optionNames.has(value) && !optionValues.has(value));
    if (unexpected) throw new Error(`Unexpected Apple mapping bootstrap argument: ${unexpected}`);
    if (plan) {
      if (confirmation)
        throw new Error("Mapping bootstrap plan does not accept live confirmation.");
      return {
        identitySeedsPath,
        mode: "mapping_bootstrap_plan",
        snapshotPath,
      };
    }
    if (confirmation !== appleMusicIdentityBootstrapConfirmation) {
      throw new Error(
        `Live mapping bootstrap requires --confirm-live ${appleMusicIdentityBootstrapConfirmation}.`,
      );
    }
    return {
      confirmation: appleMusicIdentityBootstrapConfirmation,
      identitySeedsPath,
      mode: "mapping_bootstrap_live",
      snapshotPath,
    };
  }
  if (identitySeedsPath) {
    throw new Error("--identity-seeds requires --mapping-bootstrap.");
  }
  if (sample === Boolean(cohortManifestPath)) {
    throw new Error("Choose exactly one of --sample or --cohort-manifest.");
  }
  const scope = sample ? ("sample" as const) : ("validation_25" as const);
  const snapshotPath = requiredOption(values, "--snapshot");
  const confirmation = optionalOption(values, "--confirm-live");
  const evaluationAsOf = optionalOption(values, "--evaluation-as-of");
  const profile = parseProfile(optionalOption(values, "--profile"));
  const optionNames = new Set([
    "--plan",
    "--execute-live",
    "--sample",
    "--cohort-manifest",
    "--snapshot",
    "--confirm-live",
    "--evaluation-as-of",
    "--profile",
    "--mapping-bootstrap",
    "--identity-seeds",
  ]);
  const optionValues = new Set(
    [snapshotPath, cohortManifestPath, confirmation, evaluationAsOf, profile].filter(
      (value): value is string => Boolean(value),
    ),
  );
  const unexpected = values.find((value) => !optionNames.has(value) && !optionValues.has(value));
  if (unexpected) throw new Error(`Unexpected Apple recent argument: ${unexpected}`);
  if (plan) {
    if (confirmation || (scope === "sample" && evaluationAsOf)) {
      throw new Error("Plan mode does not accept live confirmation or sample evaluation time.");
    }
    if (scope === "validation_25" && evaluationAsOf !== appleMusicRecentEvaluationTime) {
      throw new Error(
        `Validation plan requires --evaluation-as-of ${appleMusicRecentEvaluationTime}.`,
      );
    }
    if (scope === "validation_25" && profile !== "optimized_four_source") {
      throw new Error("The 25-artist validation requires optimized_four_source.");
    }
    return {
      ...(cohortManifestPath ? { cohortManifestPath } : {}),
      mode: "plan",
      profile,
      scope,
      snapshotPath,
    };
  }
  const requiredConfirmation =
    scope === "validation_25"
      ? appleMusicRecentValidationConfirmation
      : appleMusicRecentConfirmation;
  if (confirmation !== requiredConfirmation) {
    throw new Error(`Live execution requires --confirm-live ${requiredConfirmation}.`);
  }
  if (evaluationAsOf !== appleMusicRecentEvaluationTime) {
    throw new Error(`Live sample requires --evaluation-as-of ${appleMusicRecentEvaluationTime}.`);
  }
  if (scope === "validation_25" && profile !== "optimized_four_source") {
    throw new Error("The 25-artist validation requires optimized_four_source.");
  }
  return {
    ...(cohortManifestPath ? { cohortManifestPath } : {}),
    confirmation: requiredConfirmation,
    evaluationAsOf,
    mode: "execute_live",
    profile,
    scope,
    snapshotPath,
  };
}

export async function createAppleMusicRecentMappingBootstrapPlan(
  snapshotPath: string,
  identitySeedsPath: string,
  readSnapshot: (path: string) => Promise<ItunesPilotSnapshot> = readItunesPilotSnapshot,
  readArtifact = readAppleMusicIdentityBootstrapArtifact,
  validateSources = validateAppleMusicIdentityBootstrapSources,
): Promise<AppleMusicIdentityBootstrapPlan> {
  const [snapshot, artifact] = await Promise.all([
    readSnapshot(snapshotPath),
    readArtifact(identitySeedsPath),
  ]);
  const validArtifact = validateAppleMusicIdentityBootstrapArtifact(artifact, snapshot);
  await validateSources(validArtifact);
  return createAppleMusicIdentityBootstrapPlan(validArtifact, snapshot);
}

export async function createAppleMusicRecentPlan(
  snapshotPath: string,
  profile: AppleMusicRecentProfile = "current",
  readSnapshot: (path: string) => Promise<ItunesPilotSnapshot> = readItunesPilotSnapshot,
  validateSnapshot: typeof validateAppleMusicPilotSnapshot = validateAppleMusicPilotSnapshot,
  cohortManifestPath?: string,
): Promise<AppleMusicRecentPlan> {
  const snapshot = await readSnapshot(snapshotPath);
  const cohort = validateSnapshot(snapshot);
  const validationManifest = cohortManifestPath
    ? validateAppleMusicRecentValidationManifest(
        await readAppleMusicRecentValidationManifest(cohortManifestPath),
        snapshot,
      )
    : undefined;
  const artists = validationManifest
    ? validationManifest.artists.map((artist) => artist.name)
    : [...appleMusicRecentSample];
  for (const name of artists) {
    if (!cohort.some((artist) => artist.name === name)) {
      const snapshotArtist = snapshot.artists.some((artist) => artist.canonicalName === name);
      if (!validationManifest || !snapshotArtist) {
        throw new Error(`Recent artist ${name} is absent from the frozen snapshot.`);
      }
    }
  }
  const forecast = validationManifest
    ? {
        armARequests: 50,
        armBRequests: 0,
        armCRequests: 50,
        freshSearchRequests: 25,
        freshTopSongsRequests: 25,
        mappingRequests: 25,
        recurringProfileRequests: 100,
        requestBudget: 175 as const,
        reusedHistoricalRequests: 0,
        retryReserve: 25,
        targetedDetailRequests: 10,
        totalRequests: 160,
      }
    : profile === "optimized_four_source"
      ? {
          armARequests: 0,
          armBRequests: 0,
          armCRequests: 20,
          freshSearchRequests: 10,
          freshTopSongsRequests: 10,
          mappingRequests: 0,
          recurringProfileRequests: 40,
          requestBudget: 25 as const,
          reusedHistoricalRequests: 20,
          retryReserve: 5,
          targetedDetailRequests: 0,
          totalRequests: 20,
        }
      : {
          armARequests: 20,
          armBRequests: 20,
          armCRequests: 20,
          freshSearchRequests: 10,
          freshTopSongsRequests: 0,
          mappingRequests: 13,
          recurringProfileRequests: 60,
          requestBudget: 100 as const,
          reusedHistoricalRequests: 0,
          retryReserve: 10,
          targetedDetailRequests: 10,
          totalRequests: 93,
        };
  const requestBudget = validationManifest
    ? (175 as const)
    : profile === "optimized_four_source"
      ? (25 as const)
      : (100 as const);
  const maximumRuntimeMs = validationManifest
    ? (1_200_000 as const)
    : profile === "optimized_four_source"
      ? (300_000 as const)
      : (900_000 as const);
  return {
    artists,
    evaluationAsOf: appleMusicRecentEvaluationTime,
    forecast,
    limits: {
      concurrency: 1,
      maximumRuntimeMs,
      minRequestIntervalMs: 1_100,
      requestBudget,
    },
    mode: "plan",
    networkRequestsStarted: 0,
    noPagination: true,
    profile,
    scope: validationManifest ? "validation_25" : "sample",
    snapshotHash: snapshot.snapshotHash,
    storefront: "us",
    writes: 0,
  };
}

function parseProfile(value: string | undefined): AppleMusicRecentProfile {
  const profile = value ?? "current";
  if (!appleMusicRecentProfiles.includes(profile as AppleMusicRecentProfile)) {
    throw new Error(`Unsupported Apple recent profile: ${profile}`);
  }
  return profile as AppleMusicRecentProfile;
}

function requiredOption(args: string[], name: string): string {
  const value = optionalOption(args, name);
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

function optionalOption(args: string[], name: string): string | undefined {
  const positions = args.flatMap((value, index) => (value === name ? [index] : []));
  if (positions.length > 1) throw new Error(`${name} may be provided only once.`);
  const index = positions[0];
  return index === undefined ? undefined : args[index + 1];
}
