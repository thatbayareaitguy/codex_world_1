import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  diagnosticDetails,
  publicationStage,
  safeFailure,
  withPublicationDiagnostics,
} from "./showcase-diagnostics";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("private safe publication diagnostics", () => {
  it("never serializes raw messages, stacks, SQL, URLs, or unknown error codes", () => {
    const secret = "synthetic-never-log-me";
    const error = Object.assign(new Error(`postgresql://user:${secret}@host/database`), {
      code: secret,
      query: secret,
      name: secret,
      cause: new Error(secret),
    });
    const serialized = JSON.stringify(safeFailure(error));
    expect(serialized).not.toContain(secret);
    expect(safeFailure(error)).toEqual({ reason: "unclassified-error", kind: "UnknownError" });
    expect(safeFailure(new Error("__proto__")).reason).toBe("unclassified-error");
    expect(safeFailure(Object.assign(new Error(secret), { code: "ECONNRESET" })).code).toBe(
      "ECONNRESET",
    );
    error.stack = `Error: ${secret}\n    at publish (C:/private/${secret}/scripts/showcase-publish.ts:42:3)\n    at provider (https://example.com/${secret}:1:2)`;
    expect(safeFailure(error).source).toBe("scripts/showcase-publish.ts:42:3");
    expect(JSON.stringify(safeFailure(error))).not.toContain(secret);
  });

  it("persists the failed stage and a run ID without leaking the underlying error", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "showcase-diagnostics-"));
    directories.push(directory);
    vi.stubEnv("LOCALAPPDATA", directory);
    await expect(
      withPublicationDiagnostics(async () => {
        await publicationStage("neon-readback");
        expect(diagnosticDetails().runId).toMatch(/^[a-f0-9-]+$/);
        throw Object.assign(new Error("private query with synthetic password"), {
          code: "ECONNRESET",
        });
      }),
    ).rejects.toThrow();
    const runs = resolve(directory, "Showcase/publication/runs");
    const [filename] = await readdir(runs);
    const log = await readFile(resolve(runs, filename!), "utf8");
    expect(log).toContain('"stage":"neon-readback"');
    expect(log).toContain('"code":"ECONNRESET"');
    expect(log).not.toContain("synthetic password");
    expect(log).not.toContain("run-completed");
  });

  it("records successful runs and classifies known readiness and quota failures", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "showcase-diagnostics-"));
    directories.push(directory);
    vi.stubEnv("LOCALAPPDATA", directory);
    await withPublicationDiagnostics(async () => publicationStage("live-verification"));
    const runs = resolve(directory, "Showcase/publication/runs");
    const [filename] = await readdir(runs);
    expect(await readFile(resolve(runs, filename!), "utf8")).toContain("run-completed");
    expect(
      safeFailure(new Error("Apple scan is active or not fresh enough; publication deferred."))
        .reason,
    ).toBe("scanner-not-ready");
    expect(
      safeFailure(
        new Error(
          "Transfer safety budget exhausted. Existing website remains online; refresh refused.",
        ),
      ).reason,
    ).toBe("budget-exhausted");
  });
});
