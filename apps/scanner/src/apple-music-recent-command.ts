import { validateAppleMusicPilotSnapshot } from "./apple-music-pilot-definition";
import {
  appleMusicRecentConfirmation,
  appleMusicRecentEvaluationTime,
  appleMusicRecentSample,
} from "./apple-music-recent";
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
    requestBudget: 25 | 100;
    reusedHistoricalRequests: number;
    retryReserve: number;
    targetedDetailRequests: number;
    totalRequests: number;
  };
  limits: {
    concurrency: 1;
    maximumRuntimeMs: 300_000 | 900_000;
    minRequestIntervalMs: 1_100;
    requestBudget: 25 | 100;
  };
  mode: "plan";
  networkRequestsStarted: 0;
  noPagination: true;
  profile: AppleMusicRecentProfile;
  snapshotHash: string;
  storefront: "us";
  writes: 0;
}

export type AppleMusicRecentCommand =
  | { mode: "plan"; profile: AppleMusicRecentProfile; snapshotPath: string }
  | {
      confirmation: typeof appleMusicRecentConfirmation;
      evaluationAsOf: typeof appleMusicRecentEvaluationTime;
      mode: "execute_live";
      profile: AppleMusicRecentProfile;
      snapshotPath: string;
    };

export function parseAppleMusicRecentCommand(args: string[]): AppleMusicRecentCommand {
  const values = args.filter((value) => value !== "--");
  const plan = values.includes("--plan");
  const live = values.includes("--execute-live");
  if (plan === live) throw new Error("Choose exactly one of --plan or --execute-live.");
  if (!values.includes("--sample")) throw new Error("Apple recent MVP requires --sample.");
  const snapshotPath = requiredOption(values, "--snapshot");
  const confirmation = optionalOption(values, "--confirm-live");
  const evaluationAsOf = optionalOption(values, "--evaluation-as-of");
  const profile = parseProfile(optionalOption(values, "--profile"));
  const optionNames = new Set([
    "--plan",
    "--execute-live",
    "--sample",
    "--snapshot",
    "--confirm-live",
    "--evaluation-as-of",
    "--profile",
  ]);
  const optionValues = new Set(
    [snapshotPath, confirmation, evaluationAsOf, profile].filter((value): value is string =>
      Boolean(value),
    ),
  );
  const unexpected = values.find((value) => !optionNames.has(value) && !optionValues.has(value));
  if (unexpected) throw new Error(`Unexpected Apple recent argument: ${unexpected}`);
  if (plan) {
    if (confirmation || evaluationAsOf) {
      throw new Error("Plan mode does not accept live confirmation or evaluation time.");
    }
    return { mode: "plan", profile, snapshotPath };
  }
  if (confirmation !== appleMusicRecentConfirmation) {
    throw new Error(`Live execution requires --confirm-live ${appleMusicRecentConfirmation}.`);
  }
  if (evaluationAsOf !== appleMusicRecentEvaluationTime) {
    throw new Error(`Live sample requires --evaluation-as-of ${appleMusicRecentEvaluationTime}.`);
  }
  return { confirmation, evaluationAsOf, mode: "execute_live", profile, snapshotPath };
}

export async function createAppleMusicRecentPlan(
  snapshotPath: string,
  profile: AppleMusicRecentProfile = "current",
  readSnapshot: (path: string) => Promise<ItunesPilotSnapshot> = readItunesPilotSnapshot,
  validateSnapshot: typeof validateAppleMusicPilotSnapshot = validateAppleMusicPilotSnapshot,
): Promise<AppleMusicRecentPlan> {
  const snapshot = await readSnapshot(snapshotPath);
  const cohort = validateSnapshot(snapshot);
  for (const name of appleMusicRecentSample) {
    if (!cohort.some((artist) => artist.name === name)) {
      throw new Error(`Recent sample artist ${name} is absent from the pinned cohort.`);
    }
  }
  const forecast =
    profile === "optimized_four_source"
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
  const requestBudget = profile === "optimized_four_source" ? (25 as const) : (100 as const);
  const maximumRuntimeMs =
    profile === "optimized_four_source" ? (300_000 as const) : (900_000 as const);
  return {
    artists: [...appleMusicRecentSample],
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
