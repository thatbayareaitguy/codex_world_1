import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("one-time wake validation task registration", () => {
  it("is a direct hidden read-only task isolated from production workflows", () => {
    const registration = readFileSync(resolve("scripts/register-wake-validation-task.ps1"), "utf8");
    const cli = readFileSync(resolve("apps/scanner/src/wake-validation-cli.ts"), "utf8");
    expect(registration).toContain("TS New Music Radar Maintenance Wake Validation 2026-08-28");
    expect(registration).toContain("2026-08-28T02:50:00");
    expect(registration).toContain("System32\\conhost.exe");
    expect(registration).toContain('--headless `"$node`" --import tsx');
    expect(registration).toContain("-MultipleInstances IgnoreNew");
    expect(registration).toContain("-StartWhenAvailable");
    expect(registration).toContain("-WakeToRun");
    expect(registration).toContain("-ExecutionTimeLimit (New-TimeSpan -Minutes 5)");
    expect(registration).not.toContain('New-ScheduledTaskAction -Execute "powershell.exe"');
    expect(registration).not.toContain("pnpm.cmd");
    expect(registration).not.toContain("discovery-scheduler-cli.ts");
    expect(registration).not.toContain("discovery-maintenance-cli.ts");
    expect(cli).not.toContain("@radar/db");
    expect(cli).not.toContain("@radar/providers");
    expect(cli).not.toContain("runDiscoverySchedulerTick");
    expect(cli).not.toContain("playlist");
  });
});
