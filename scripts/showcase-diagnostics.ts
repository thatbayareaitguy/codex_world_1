import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { updateRuntimeDirectory } from "./showcase-update-budget";

export type PublicationStage =
  | "startup"
  | "preflight"
  | "budget"
  | "configuration"
  | "neon-read-prior"
  | "scanner-readiness"
  | "scanner-snapshot"
  | "catalog-validation"
  | "feed-artwork"
  | "neon-publish"
  | "neon-readback"
  | "local-snapshot"
  | "live-status"
  | "deployment"
  | "deployment-auth"
  | "live-verification"
  | "record-outcome"
  | "recovery-reserved";

const context = new AsyncLocalStorage<{
  runId: string;
  path: string;
  stage: PublicationStage;
  recoveryAttempts: number;
}>();
const knownMessages: Readonly<Record<string, string>> = {
  "Wrong publication worktree.": "wrong-worktree",
  "Uncommitted application edits block unattended deployment.": "dirty-worktree",
  "Apple scan is active or not fresh enough; publication deferred.": "scanner-not-ready",
  "Neon round-trip verification failed.": "neon-hash-mismatch",
  "Live catalog verification failed.": "live-hash-mismatch",
  "Deployment deadline exceeded.": "deployment-timeout",
  "Vercel deployment failed.": "deployment-failed",
  "Transfer safety budget exhausted. Existing website remains online; refresh refused.":
    "budget-exhausted",
  "Maximum eight update attempts per rolling seven days reached.": "attempt-limit",
  "Vercel authentication failed.": "vercel-authentication",
  "Vercel upload exceeded its limit.": "vercel-upload-limit",
  "Vercel build failed.": "vercel-build-failed",
  "Vercel network request failed.": "vercel-network",
  "Live catalog status could not be read.": "live-status-unavailable",
  "Catalog exceeds the 8 MB transfer safety limit.": "catalog-read-limit",
  "Catalog exceeds publication size budget.": "catalog-publish-limit",
  "Refusing empty public catalog.": "empty-catalog",
  "Catalog count dropped by more than 10%; editorial review is required before publication.":
    "catalog-count-drop",
  "Catalog contains an unresolved artist-page reference.": "unresolved-artist-reference",
  "The Showcase Neon catalog integrity check failed.": "stored-hash-mismatch",
  "The Showcase Neon catalog has not been published yet.": "missing-catalog",
};
const safeCodes = new Set([
  "ENOENT",
  "EEXIST",
  "EACCES",
  "EPERM",
  "EBUSY",
  "ENOSPC",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "57014",
  "42501",
  "53300",
  "57P01",
  "08006",
  "08001",
  "UNDEFINED_VALUE",
  "EPIPE",
  "ENOBUFS",
  "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL",
  "ERR_STREAM_DESTROYED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "23505",
  "23502",
  "22023",
  "42601",
  "42P01",
  "28P01",
]);
const diagnosticFiles = new Set([
  "scripts/showcase-update.ts",
  "scripts/showcase-deploy.ts",
  "scripts/showcase-publish.ts",
  "scripts/showcase-recovery.ts",
  "scripts/showcase-update-budget.ts",
  "scripts/showcase-update-policy.ts",
  "scripts/showcase-neon-reader.ts",
  "scripts/showcase-publication-safety.ts",
  "apps/scanner/src/showcase-neon-publication.ts",
  "apps/scanner/src/showcase-apple-feed.ts",
  "apps/scanner/src/showcase-publication.ts",
  "apps/scanner/src/showcase-editorial-policy.ts",
]);

export function safeFailure(error: unknown) {
  const exitCode = error instanceof Error && "cliExitCode" in error ? error.cliExitCode : undefined;
  const signal = error instanceof Error && "cliSignal" in error ? error.cliSignal : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  const frame =
    error instanceof Error
      ? error.stack
          ?.replaceAll("\\", "/")
          .split("\n")
          .slice(1)
          .flatMap((line) => {
            const match =
              /^\s+at .*?((?:scripts|apps\/scanner\/src)\/showcase-[a-z-]+\.ts):(\d{1,5}):(\d{1,5})/.exec(
                line,
              );
            return match && diagnosticFiles.has(match[1]!)
              ? [`${match[1]}:${match[2]}:${match[3]}`]
              : [];
          })[0]
      : undefined;
  return {
    reason:
      error instanceof Error
        ? Object.hasOwn(knownMessages, error.message)
          ? (knownMessages[error.message] ?? "unclassified-error")
          : "unclassified-error"
        : "unclassified-error",
    kind:
      error instanceof Error &&
      [
        "Error",
        "TypeError",
        "RangeError",
        "ZodError",
        "AbortError",
        "TimeoutError",
        "PostgresError",
      ].includes(error.name)
        ? error.name
        : "UnknownError",
    ...(typeof code === "string" && safeCodes.has(code) ? { code } : {}),
    ...(frame === undefined ? {} : { source: frame }),
    ...(typeof exitCode === "number" &&
    Number.isInteger(exitCode) &&
    exitCode >= 0 &&
    exitCode <= 0xffffffff
      ? { cliExitCode: exitCode }
      : {}),
    ...(typeof signal === "string" &&
    ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(signal)
      ? { cliSignal: signal }
      : {}),
    // Deliberately omit messages, stacks, URLs, SQL, and arbitrary provider/CLI output.
  };
}

export function diagnosticDetails() {
  const current = context.getStore();
  return {
    runId: current?.runId,
    stage: current?.stage ?? "startup",
    recoveryAttempts: current?.recoveryAttempts ?? 0,
  };
}

export async function publicationStage(stage: PublicationStage): Promise<void> {
  const current = context.getStore();
  if (!current) return;
  current.stage = stage;
  if (stage === "recovery-reserved") current.recoveryAttempts += 1;
  const event = { event: "stage-start", at: new Date().toISOString(), runId: current.runId, stage };
  await appendFile(current.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  console.info(JSON.stringify(event));
}

export async function recordDiagnosticFailure(error: unknown): Promise<void> {
  const current = context.getStore();
  if (!current) return;
  await appendFile(
    current.path,
    `${JSON.stringify({ event: "failure", at: new Date().toISOString(), ...diagnosticDetails(), ...safeFailure(error) })}\n`,
  );
}

export async function withPublicationDiagnostics<T>(operation: () => Promise<T>): Promise<T> {
  const directory = resolve(updateRuntimeDirectory(), "runs");
  await mkdir(directory, { recursive: true });
  const runId = randomUUID();
  return context.run(
    { runId, path: resolve(directory, `${runId}.jsonl`), stage: "startup", recoveryAttempts: 0 },
    async () => {
      await publicationStage("startup");
      try {
        const result = await operation();
        await appendFile(
          context.getStore()!.path,
          `${JSON.stringify({ event: "run-completed", at: new Date().toISOString(), ...diagnosticDetails() })}\n`,
        );
        return result;
      } catch (error) {
        await recordDiagnosticFailure(error);
        throw error;
      }
    },
  );
}
