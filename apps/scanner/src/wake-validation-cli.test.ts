import { describe, expect, it, vi } from "vitest";
import {
  countPowerShellSystemRequests,
  readOptionalPowerRequests,
  runWakeValidation,
} from "./wake-validation-cli";
import type { KeepAwakeDiagnosticRecord } from "./windows-power-diagnostics";

describe("one-time Windows wake validation", () => {
  it("records activation and release without invoking production work", async () => {
    let clock = Date.parse("2026-08-28T09:50:00.000Z");
    let alive = true;
    let diagnostics = diagnosticRecord();
    const release = vi.fn(() => {
      alive = false;
      diagnostics = {
        ...diagnostics,
        finalReleased: true,
        releasedAt: "2026-08-28T09:50:02.000Z",
        state: "released",
      };
      return Promise.resolve();
    });
    const writeResult = vi.fn(() => Promise.resolve());
    const result = await runWakeValidation({
      acquirePower: () => ({
        diagnosticPath: "C:\\synthetic-diagnostic.json",
        processId: 1234,
        readDiagnostics: () => Promise.resolve(diagnostics),
        release,
      }),
      holdMs: 2_000,
      now: () => new Date(clock),
      outputPath: "C:\\synthetic-result.json",
      powerRequests: () =>
        Promise.reject(new Error("This command requires administrator privileges.")),
      processAlive: () => alive,
      sleep: (milliseconds) => {
        clock += milliseconds;
        return Promise.resolve();
      },
      writeResult,
    });
    expect(result).toMatchObject({
      activated: true,
      helperAliveAfterRelease: false,
      helperAliveDuring: true,
      optionalPowerCfg: {
        after: { available: false, error: "access_denied" },
        during: { available: false, error: "access_denied" },
      },
      released: true,
      status: "passed",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(writeResult).toHaveBeenCalledTimes(1);
  });

  it("treats an unavailable powercfg query as optional diagnostics", async () => {
    await expect(
      readOptionalPowerRequests(() => Promise.reject(new Error("Access is denied."))),
    ).resolves.toEqual({
      available: false,
      error: "access_denied",
      powerShellSystemRequests: null,
    });
  });

  it("counts only PowerShell requests in the SYSTEM section", () => {
    expect(
      countPowerShellSystemRequests(
        "SYSTEM:\r\n[PROCESS] C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n[PROCESS] C:\\node.exe\r\nDISPLAY:\r\n[PROCESS] C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe(1);
  });
});

function diagnosticRecord(): KeepAwakeDiagnosticRecord {
  return {
    abnormalExitDetectedAt: null,
    activatedAt: "2026-08-28T09:50:00.050Z",
    contextUpdatedAt: "2026-08-28T09:50:00.000Z",
    finalReleased: false,
    helperProcessId: 1234,
    maximumRuntimeMs: 32_000,
    ownerProcessId: 1000,
    phase: "one_time_live_validation",
    reason: "wake_validation",
    recoveredAt: null,
    releaseReason: null,
    releaseRequestedAt: null,
    releasedAt: null,
    requestedAt: "2026-08-28T09:50:00.000Z",
    runId: "synthetic-run",
    state: "active",
    version: 1,
  };
}
