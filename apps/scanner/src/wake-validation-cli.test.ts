import { describe, expect, it, vi } from "vitest";
import { countPowerShellSystemRequests, runWakeValidation } from "./wake-validation-cli";

describe("one-time Windows wake validation", () => {
  it("records activation and release without invoking production work", async () => {
    let clock = Date.parse("2026-08-28T09:50:00.000Z");
    let alive = true;
    const release = vi.fn(() => {
      alive = false;
      return Promise.resolve();
    });
    const writeResult = vi.fn(() => Promise.resolve());
    let snapshots = 0;
    const result = await runWakeValidation({
      acquirePower: () => ({ processId: 1234, release }),
      clearMarker: () => Promise.resolve(),
      holdMs: 2_000,
      markerPath: "C:\\synthetic-marker",
      now: () => new Date(clock),
      outputPath: "C:\\synthetic-result.json",
      powerRequests: () => {
        snapshots += 1;
        return Promise.resolve(
          snapshots === 1 || !alive
            ? "SYSTEM:\r\nNone.\r\nDISPLAY:\r\nNone."
            : "SYSTEM:\r\n[PROCESS] \\Device\\HarddiskVolume3\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\nDISPLAY:\r\nNone.",
        );
      },
      processAlive: () => alive,
      readMarker: () => Promise.resolve("2026-08-28T09:50:00.500Z"),
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
      released: true,
      status: "passed",
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(writeResult).toHaveBeenCalledTimes(1);
  });

  it("counts only PowerShell requests in the SYSTEM section", () => {
    expect(
      countPowerShellSystemRequests(
        "SYSTEM:\r\n[PROCESS] C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n[PROCESS] C:\\node.exe\r\nDISPLAY:\r\n[PROCESS] C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      ),
    ).toBe(1);
  });
});
