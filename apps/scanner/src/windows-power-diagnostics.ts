import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export type KeepAwakeDiagnosticState =
  | "starting"
  | "active"
  | "release_requested"
  | "released"
  | "recovery_pending"
  | "recovered_after_abnormal_exit";

export interface KeepAwakeDiagnosticRecord {
  abnormalExitDetectedAt: string | null;
  activatedAt: string | null;
  contextUpdatedAt: string;
  finalReleased: boolean;
  helperProcessId: number | null;
  maximumRuntimeMs: number;
  ownerProcessId: number;
  phase: string;
  reason: string;
  recoveredAt: string | null;
  releaseReason: string | null;
  releaseRequestedAt: string | null;
  releasedAt: string | null;
  requestedAt: string;
  runId: string;
  state: KeepAwakeDiagnosticState;
  version: 1;
}

export interface KeepAwakeDiagnosticPaths {
  activationPath: string;
  directory: string;
  ownerPath: string;
  recordPath: string;
  releasePath: string;
  releaseSignalPath: string;
}

interface HelperMarker {
  activatedAt?: string;
  helperProcessId?: number;
  releaseReason?: string;
  releasedAt?: string;
}

export function defaultKeepAwakeDiagnosticDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is required for keep-awake diagnostics.");
  return resolve(localAppData, "TSNewMusicRadar", "logs", "keep-awake");
}

export function keepAwakeDiagnosticPaths(
  directory: string,
  runId: string,
): KeepAwakeDiagnosticPaths {
  return {
    activationPath: resolve(directory, `${runId}.activated.json`),
    directory,
    ownerPath: resolve(directory, "active-owner.json"),
    recordPath: resolve(directory, `${runId}.json`),
    releasePath: resolve(directory, `${runId}.released.json`),
    releaseSignalPath: resolve(directory, `${runId}.release`),
  };
}

export function claimKeepAwakeOwner(input: {
  directory: string;
  maximumRuntimeMs: number;
  now: Date;
  ownerProcessId: number;
  phase: string;
  processAlive: (processId: number) => boolean;
  reason: string;
  runId: string;
}): { paths: KeepAwakeDiagnosticPaths; record: KeepAwakeDiagnosticRecord } {
  mkdirSync(input.directory, { recursive: true });
  const paths = keepAwakeDiagnosticPaths(input.directory, input.runId);
  recoverAbandonedOwner(paths.ownerPath, input.now, input.processAlive);
  const timestamp = input.now.toISOString();
  const record: KeepAwakeDiagnosticRecord = {
    abnormalExitDetectedAt: null,
    activatedAt: null,
    contextUpdatedAt: timestamp,
    finalReleased: false,
    helperProcessId: null,
    maximumRuntimeMs: input.maximumRuntimeMs,
    ownerProcessId: input.ownerProcessId,
    phase: input.phase,
    reason: input.reason,
    recoveredAt: null,
    releaseReason: null,
    releaseRequestedAt: null,
    releasedAt: null,
    requestedAt: timestamp,
    runId: input.runId,
    state: "starting",
    version: 1,
  };
  try {
    writeExclusiveJsonSync(paths.ownerPath, record);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error("A scanner keep-awake owner is already active; refusing a duplicate owner.");
    }
    throw error;
  }
  writeRecordSync(paths.recordPath, record);
  return { paths, record };
}

export function updateKeepAwakeRecordSync(
  paths: KeepAwakeDiagnosticPaths,
  updates: Partial<KeepAwakeDiagnosticRecord>,
): KeepAwakeDiagnosticRecord {
  const current = mergeMarkers(
    readRecordSync(paths.recordPath),
    readJsonSync<HelperMarker>(paths.activationPath),
    readJsonSync<HelperMarker>(paths.releasePath),
  );
  const record = { ...current, ...updates };
  writeRecordSync(paths.recordPath, record);
  return record;
}

export async function readKeepAwakeRecord(
  paths: KeepAwakeDiagnosticPaths,
): Promise<KeepAwakeDiagnosticRecord | null> {
  const record = await readJson<KeepAwakeDiagnosticRecord>(paths.recordPath);
  if (!record) return null;
  const activation = await readJson<HelperMarker>(paths.activationPath);
  const release = await readJson<HelperMarker>(paths.releasePath);
  return mergeMarkers(record, activation, release);
}

export async function requestKeepAwakeRelease(
  paths: KeepAwakeDiagnosticPaths,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const record = await readKeepAwakeRecord(paths);
  if (!record || record.finalReleased) return;
  await writeFile(paths.releaseSignalPath, `${timestamp}\n`, "utf8");
  const updated: KeepAwakeDiagnosticRecord = {
    ...record,
    contextUpdatedAt: timestamp,
    releaseRequestedAt: timestamp,
    state: "release_requested",
  };
  await writeJson(paths.recordPath, updated);
}

export async function finalizeKeepAwakeRelease(
  paths: KeepAwakeDiagnosticPaths,
  now: Date,
  fallbackReleaseReason: string,
): Promise<KeepAwakeDiagnosticRecord | null> {
  const record = await readKeepAwakeRecord(paths);
  if (!record) return null;
  const releasedAt = record.releasedAt ?? now.toISOString();
  const updated: KeepAwakeDiagnosticRecord = {
    ...record,
    contextUpdatedAt: releasedAt,
    finalReleased: true,
    releaseReason: record.releaseReason ?? fallbackReleaseReason,
    releasedAt,
    state: "released",
  };
  await writeJson(paths.recordPath, updated);
  const owner = await readJson<KeepAwakeDiagnosticRecord>(paths.ownerPath);
  if (owner?.runId === record.runId) await rm(paths.ownerPath, { force: true });
  await rm(paths.releaseSignalPath, { force: true });
  return updated;
}

function recoverAbandonedOwner(
  ownerPath: string,
  now: Date,
  processAlive: (processId: number) => boolean,
): void {
  if (!existsSync(ownerPath)) return;
  const owner = readJsonSync<KeepAwakeDiagnosticRecord>(ownerPath);
  if (!owner) {
    recoverCorruptOwner(ownerPath, now, processAlive);
    return;
  }
  if (processAlive(owner.ownerProcessId)) {
    throw new Error("A scanner keep-awake owner is already active; refusing a duplicate owner.");
  }
  const paths = keepAwakeDiagnosticPaths(dirname(ownerPath), owner.runId);
  const detectedAt = now.toISOString();
  const previous = mergeMarkers(
    readJsonSync<KeepAwakeDiagnosticRecord>(paths.recordPath) ?? owner,
    readJsonSync<HelperMarker>(paths.activationPath),
    readJsonSync<HelperMarker>(paths.releasePath),
  );
  if (previous.helperProcessId && processAlive(previous.helperProcessId)) {
    const pending: KeepAwakeDiagnosticRecord = {
      ...previous,
      abnormalExitDetectedAt: previous.abnormalExitDetectedAt ?? detectedAt,
      contextUpdatedAt: detectedAt,
      state: "recovery_pending",
    };
    writeRecordSync(paths.recordPath, pending);
    throw new Error(
      "A keep-awake helper from an exited owner is still releasing; retry after it exits.",
    );
  }
  const recovered: KeepAwakeDiagnosticRecord = {
    ...previous,
    abnormalExitDetectedAt: previous.abnormalExitDetectedAt ?? detectedAt,
    contextUpdatedAt: detectedAt,
    finalReleased: true,
    recoveredAt: detectedAt,
    releaseReason: previous.releaseReason ?? "owner_process_exited",
    releasedAt: previous.releasedAt ?? detectedAt,
    state: "recovered_after_abnormal_exit",
  };
  writeRecordSync(paths.recordPath, recovered);
  rmSync(ownerPath, { force: true });
  rmSync(paths.releaseSignalPath, { force: true });
}

function mergeMarkers(
  record: KeepAwakeDiagnosticRecord,
  activation: HelperMarker | null,
  release: HelperMarker | null,
): KeepAwakeDiagnosticRecord {
  const activatedAt = activation?.activatedAt ?? record.activatedAt;
  const releasedAt = release?.releasedAt ?? record.releasedAt;
  return {
    ...record,
    activatedAt,
    finalReleased: releasedAt ? true : record.finalReleased,
    helperProcessId: activation?.helperProcessId ?? record.helperProcessId,
    releaseReason: release?.releaseReason ?? record.releaseReason,
    releasedAt,
    state: releasedAt
      ? record.state === "recovered_after_abnormal_exit"
        ? record.state
        : "released"
      : activatedAt
        ? "active"
        : record.state,
  };
}

function readRecordSync(path: string): KeepAwakeDiagnosticRecord {
  const record = readJsonSync<KeepAwakeDiagnosticRecord>(path);
  if (!record) throw new Error(`Keep-awake diagnostic record is missing: ${path}`);
  return record;
}

function readJsonSync<T>(path: string): T | null {
  try {
    return parseJson<T>(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return parseJson<T>(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function writeRecordSync(path: string, record: KeepAwakeDiagnosticRecord): void {
  writeFileSync(path, serialize(record), "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, serialize(value), "utf8");
}

function writeExclusiveJsonSync(path: string, value: unknown): void {
  const temporaryPath = temporaryJsonPath(path);
  try {
    writeFileSync(temporaryPath, serialize(value), { encoding: "utf8", flag: "wx" });
    // Linking a complete same-volume temporary file gives us an atomic create-if-absent claim.
    // A crash can leave an extra temporary hard link, but never a truncated active owner.
    linkSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function recoverCorruptOwner(
  ownerPath: string,
  now: Date,
  processAlive: (processId: number) => boolean,
): void {
  const directory = dirname(ownerPath);
  const candidates = readdirSync(directory)
    .filter(
      (name) =>
        name.endsWith(".json") &&
        name !== "active-owner.json" &&
        !name.includes(".activated.") &&
        !name.includes(".released.") &&
        !name.includes(".corrupt-"),
    )
    .map((name) => readJsonSync<KeepAwakeDiagnosticRecord>(resolve(directory, name)))
    .filter((record): record is KeepAwakeDiagnosticRecord => isKeepAwakeRecord(record))
    .map((record) => {
      const paths = keepAwakeDiagnosticPaths(directory, record.runId);
      return {
        paths,
        record: mergeMarkers(
          record,
          readJsonSync<HelperMarker>(paths.activationPath),
          readJsonSync<HelperMarker>(paths.releasePath),
        ),
      };
    })
    .filter(({ record }) => !record.finalReleased);

  const liveOwner = candidates.find(({ record }) => processAlive(record.ownerProcessId));
  if (liveOwner) {
    throw new Error("A scanner keep-awake owner is already active; refusing a duplicate owner.");
  }
  const liveHelper = candidates.find(
    ({ record }) => record.helperProcessId && processAlive(record.helperProcessId),
  );
  if (liveHelper) {
    const detectedAt = now.toISOString();
    const pending: KeepAwakeDiagnosticRecord = {
      ...liveHelper.record,
      abnormalExitDetectedAt: liveHelper.record.abnormalExitDetectedAt ?? detectedAt,
      contextUpdatedAt: detectedAt,
      state: "recovery_pending",
    };
    writeRecordSync(liveHelper.paths.recordPath, pending);
    throw new Error(
      "A keep-awake helper from an exited owner is still releasing; retry after it exits.",
    );
  }

  if (candidates.length === 0) {
    const ageMs = now.getTime() - statSync(ownerPath).mtimeMs;
    if (ageMs < 30_000) {
      throw new Error(
        "The scanner keep-awake owner record is unreadable and recent; retrying is required before recovery.",
      );
    }
  }

  const detectedAt = now.toISOString();
  for (const candidate of candidates) {
    const recovered: KeepAwakeDiagnosticRecord = {
      ...candidate.record,
      abnormalExitDetectedAt: candidate.record.abnormalExitDetectedAt ?? detectedAt,
      contextUpdatedAt: detectedAt,
      finalReleased: true,
      recoveredAt: detectedAt,
      releaseReason: candidate.record.releaseReason ?? "corrupt_owner_recovered",
      releasedAt: candidate.record.releasedAt ?? detectedAt,
      state: "recovered_after_abnormal_exit",
    };
    writeRecordSync(candidate.paths.recordPath, recovered);
    rmSync(candidate.paths.releaseSignalPath, { force: true });
  }
  const archivePath = `${ownerPath}.corrupt-${detectedAt.replace(/[:.]/g, "-")}`;
  renameSync(ownerPath, archivePath);
}

function isKeepAwakeRecord(value: unknown): value is KeepAwakeDiagnosticRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<KeepAwakeDiagnosticRecord>;
  return (
    record.version === 1 &&
    typeof record.runId === "string" &&
    typeof record.ownerProcessId === "number" &&
    typeof record.finalReleased === "boolean"
  );
}

function temporaryJsonPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value.replace(/^\uFEFF/, "")) as T;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
