import { setTimeout as delay } from "node:timers/promises";
import {
  publicationStage,
  recordDiagnosticFailure,
  safeFailure,
  type PublicationStage,
} from "./showcase-diagnostics";

export type ReserveRecovery = () => Promise<boolean>;
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "EBUSY",
  "EPERM",
  "57P01",
  "08006",
  "08001",
]);

export function isRecoverable(error: unknown): boolean {
  const failure = safeFailure(error);
  return (
    (failure.code !== undefined && transientCodes.has(failure.code)) ||
    [
      "vercel-network",
      "deployment-failed",
      "live-hash-mismatch",
      "live-status-unavailable",
    ].includes(failure.reason)
  );
}

// Never used for scanner, Feed or publishing writes. One shared per-run reservation
// limits recovery across every read, local-file and deployment stage combined.
export async function recoverOnce<T>(
  stage: PublicationStage,
  operation: () => Promise<T>,
  reserve: ReserveRecovery,
  wait: () => Promise<void> = async () => {
    await delay(2_000);
  },
): Promise<T> {
  await publicationStage(stage);
  try {
    return await operation();
  } catch (error) {
    await recordDiagnosticFailure(error);
    if (!isRecoverable(error) || !(await reserve())) throw error;
    await publicationStage("recovery-reserved");
    await wait();
    await publicationStage(stage);
    return operation();
  }
}

export async function publishAndVerify(options: {
  write: () => Promise<unknown>;
  verify: () => Promise<void>;
  reserve: ReserveRecovery;
}): Promise<void> {
  await publicationStage("neon-publish");
  try {
    await options.write();
  } catch (error) {
    await recordDiagnosticFailure(error);
    if (!isRecoverable(error) || !(await options.reserve())) throw error;
    // A lost write acknowledgement can follow a successful commit. Read back the
    // expected content once instead of blindly retrying a publishing write.
    await publicationStage("recovery-reserved");
    await publicationStage("neon-readback");
    await options.verify();
    return;
  }
  await recoverOnce("neon-readback", options.verify, options.reserve);
}
