import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runShowcaseUpdate } from "./showcase-update";
import { withPublicationDiagnostics, publicationStage } from "./showcase-diagnostics";
import { initializeBudget, updateRuntimeDirectory } from "./showcase-update-budget";

const mock = vi.hoisted(() => ({ git: vi.fn(), spawn: vi.fn(), publish: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: mock.git, spawn: mock.spawn }));
vi.mock("./showcase-publish", () => ({ publishShowcaseCatalog: mock.publish }));
const originalArguments = process.argv;
let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(resolve(tmpdir(), "showcase-run-test-"));
  vi.stubEnv("LOCALAPPDATA", directory);
  vi.stubEnv("SHOWCASE_SCANNER_ENV_PATH", "synthetic-path");
  vi.stubEnv("SHOWCASE_PUBLICATION_SCHEDULED", "false");
  process.argv = ["node", "test"];
  mock.git.mockReturnValue({ status: 0, stdout: "codex/showcase-public-site" });
  await initializeBudget();
});
afterEach(async () => {
  process.argv = originalArguments;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const latest = async (): Promise<unknown> =>
  JSON.parse(await readFile(resolve(updateRuntimeDirectory(), "latest.json"), "utf8"));

describe("update outcome logging", () => {
  it("records preflight failure before any budget or network work", async () => {
    mock.git.mockReturnValue({ status: 0, stdout: "wrong-branch" });
    await expect(withPublicationDiagnostics(runShowcaseUpdate)).rejects.toThrow(/worktree/);
    expect(await latest()).toMatchObject({
      state: "failed_or_deferred",
      stage: "preflight",
      reason: "wrong-worktree",
    });
    expect(mock.publish).not.toHaveBeenCalled();
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it("records dirty scheduled preflight and leaves publication untouched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:00:00Z"));
    process.argv.push("--scheduled");
    mock.git
      .mockReturnValueOnce({ status: 0, stdout: "codex/showcase-public-site" })
      .mockReturnValueOnce({ status: 0, stdout: "scripts/showcase-update.ts" })
      .mockReturnValueOnce({ status: 0, stdout: "" });
    await expect(withPublicationDiagnostics(runShowcaseUpdate)).rejects.toThrow(/Uncommitted/);
    expect(await latest()).toMatchObject({ stage: "preflight", reason: "dirty-worktree" });
    expect(mock.publish).not.toHaveBeenCalled();
  });
  it("records a successful no-change check without a deployment", async () => {
    const hash = "a".repeat(64);
    mock.publish.mockResolvedValue({ changed: false, contentSha256: hash });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ contentSha256: hash })))),
    );
    await withPublicationDiagnostics(runShowcaseUpdate);
    expect(await latest()).toMatchObject({
      state: "completed",
      deployed: false,
      recoveryAttempts: 0,
    });
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it("retains the true failed stage but never the private exception text", async () => {
    mock.publish.mockImplementation(async () => {
      await publicationStage("neon-readback");
      throw Object.assign(new Error("postgresql://private:synthetic-secret@host/database"), {
        code: "ECONNRESET",
      });
    });
    await expect(withPublicationDiagnostics(runShowcaseUpdate)).rejects.toThrow();
    expect(await latest()).toMatchObject({ stage: "neon-readback", code: "ECONNRESET" });
    expect(JSON.stringify(await latest())).not.toContain("synthetic-secret");
  });
  it("reserves one retry for unavailable live status but never blindly deploys", async () => {
    mock.publish.mockResolvedValue({ changed: false, contentSha256: "a".repeat(64) });
    const request = vi.fn(() => Promise.resolve(new Response("unavailable", { status: 503 })));
    vi.stubGlobal("fetch", request);
    await expect(withPublicationDiagnostics(runShowcaseUpdate)).rejects.toThrow(/status/);
    expect(request).toHaveBeenCalledTimes(2);
    expect(mock.spawn).not.toHaveBeenCalled();
    expect(await latest()).toMatchObject({
      stage: "live-status",
      reason: "live-status-unavailable",
      recoveryAttempts: 1,
    });
    const ledger = await readFile(
      resolve(updateRuntimeDirectory(), "transfer-budget.json"),
      "utf8",
    );
    expect((ledger.match(/"bytes": 32000000/g) ?? []).length).toBe(2);
  });
});
