import {
  acquireOperationLock,
  claimSpotifySyncCampaignWork,
  finishSpotifySyncCampaignWork,
  getSpotifyOperationalStatus,
  getSpotifySyncCampaignStatus,
  planSpotifySyncCampaignTick,
  releaseOperationLock,
  type RadarDatabase,
  type SpotifySchedulerLimits,
  type SpotifySyncCampaignClaim,
  type SpotifySyncCampaignStatusView,
} from "@radar/db";
import type { SpotifySchedulerExecutor } from "./spotify-scheduler";
import {
  schedulerErrorClassification,
  SpotifySchedulerRequestBudgetError,
  SpotifySchedulerRuntimeBudgetError,
} from "./spotify-scheduler";

export type SpotifySyncCampaignTickReason =
  | "planned"
  | "completed"
  | "failed"
  | "cooldown"
  | "campaign_not_running"
  | "base_spacing"
  | "canary_review"
  | "campaign_paused"
  | "campaign_complete"
  | "no_authorized_work";

export interface SpotifySyncCampaignTickResult {
  mode: "plan" | "production";
  reason: SpotifySyncCampaignTickReason;
  requestsStarted: number;
  selected: SpotifySyncCampaignClaim | null;
  status: SpotifySyncCampaignStatusView;
}

interface CampaignTickDependencies {
  acquireLock: typeof acquireOperationLock;
  claimWork: typeof claimSpotifySyncCampaignWork;
  finishWork: typeof finishSpotifySyncCampaignWork;
  getOperationalStatus: typeof getSpotifyOperationalStatus;
  getStatus: typeof getSpotifySyncCampaignStatus;
  planTick: typeof planSpotifySyncCampaignTick;
  releaseLock: typeof releaseOperationLock;
}

const productionDependencies: CampaignTickDependencies = {
  acquireLock: acquireOperationLock,
  claimWork: claimSpotifySyncCampaignWork,
  finishWork: finishSpotifySyncCampaignWork,
  getOperationalStatus: getSpotifyOperationalStatus,
  getStatus: getSpotifySyncCampaignStatus,
  planTick: planSpotifySyncCampaignTick,
  releaseLock: releaseOperationLock,
};

export async function runSpotifySyncCampaignTick(
  db: RadarDatabase,
  input: {
    campaignId: string;
    dependencies?: CampaignTickDependencies;
    executor?: SpotifySchedulerExecutor;
    limits: SpotifySchedulerLimits;
    mode: "plan" | "production";
    now?: () => Date;
  },
): Promise<SpotifySyncCampaignTickResult> {
  const now = input.now ?? (() => new Date());
  const dependencies = input.dependencies ?? productionDependencies;
  if (input.mode === "plan") {
    const selected = await dependencies.planTick(db, input.campaignId, now());
    const status = await requiredStatus(dependencies, db, input.campaignId);
    return { mode: "plan", reason: "planned", requestsStarted: 0, selected, status };
  }
  if (!input.executor) throw new Error("Spotify campaign execution requires an executor.");
  const before = await requiredStatus(dependencies, db, input.campaignId);
  const noOpReason = campaignNoOpReason(before, now());
  if (noOpReason) {
    return {
      mode: "production",
      reason: noOpReason,
      requestsStarted: 0,
      selected: null,
      status: before,
    };
  }

  const lock = await dependencies.acquireLock(db, {
    lockKey: "scan:global",
    metadata: { campaignId: input.campaignId, provider: "spotify", scheduler: true },
    operationType: "spotify_sync_campaign_tick",
    ttlMs: input.limits.maxRuntimeMs + 30_000,
  });
  let requestsStarted = 0;
  let selected: SpotifySyncCampaignClaim | null = null;
  try {
    const operational = await dependencies.getOperationalStatus(db, now());
    if (operational.cooldownActive) {
      return {
        mode: "production",
        reason: "cooldown",
        requestsStarted: 0,
        selected: null,
        status: await requiredStatus(dependencies, db, input.campaignId),
      };
    }
    selected = await dependencies.claimWork(db, input.campaignId, now());
    if (!selected) {
      const status = await requiredStatus(dependencies, db, input.campaignId);
      return {
        mode: "production",
        reason: campaignNoOpReason(status, now()) ?? "no_authorized_work",
        requestsStarted: 0,
        selected: null,
        status,
      };
    }
    const startedAt = now();
    const deadlineAt = startedAt.getTime() + input.limits.maxRuntimeMs;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new SpotifySchedulerRuntimeBudgetError()),
      Math.max(1, deadlineAt - now().getTime()),
    );
    timer.unref();
    try {
      await input.executor.execute(selected, {
        deadlineAt,
        signal: controller.signal,
        wrapRequestGate: (gate) => ({
          acquire: async (request) => {
            if (requestsStarted >= input.limits.maxRequestsPerTick) {
              throw new SpotifySchedulerRequestBudgetError(input.limits.maxRequestsPerTick);
            }
            if (now().getTime() + input.limits.minRequestIntervalMs > deadlineAt) {
              throw new SpotifySchedulerRuntimeBudgetError();
            }
            const permit = await gate.acquire({ ...request, signal: controller.signal });
            requestsStarted += 1;
            return permit;
          },
          complete: (permit, completion) => gate.complete(permit, completion),
        }),
      });
      await dependencies.finishWork(db, selected, { status: "completed" }, now());
      return {
        mode: "production",
        reason: "completed",
        requestsStarted,
        selected,
        status: await requiredStatus(dependencies, db, input.campaignId),
      };
    } catch (error) {
      const classification = schedulerErrorClassification(error);
      await dependencies.finishWork(
        db,
        selected,
        { errorClassification: classification, status: "retry" },
        now(),
      );
      return {
        mode: "production",
        reason: "failed",
        requestsStarted,
        selected,
        status: await requiredStatus(dependencies, db, input.campaignId),
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await dependencies.releaseLock(db, lock);
  }
}

async function requiredStatus(
  dependencies: CampaignTickDependencies,
  db: RadarDatabase,
  campaignId: string,
): Promise<SpotifySyncCampaignStatusView> {
  const status = await dependencies.getStatus(db, campaignId);
  if (!status) throw new Error("Spotify sync campaign does not exist.");
  return status;
}

function campaignNoOpReason(
  status: SpotifySyncCampaignStatusView,
  now: Date,
): SpotifySyncCampaignTickReason | null {
  if (status.status === "canary_review") return "canary_review";
  if (status.status === "paused") return "campaign_paused";
  if (["completed", "cancelled", "failed"].includes(status.status)) return "campaign_complete";
  if (status.status === "planned") return "campaign_not_running";
  if (
    status.status === "running" &&
    status.detailBacklog === 0 &&
    status.trackBacklog === 0 &&
    status.nextBaseClaimAt &&
    status.nextBaseClaimAt > now
  ) {
    return "base_spacing";
  }
  return null;
}
