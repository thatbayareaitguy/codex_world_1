import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("discovery maintenance Windows tasks", () => {
  it("keeps minute scheduling separate from bounded wake maintenance", () => {
    const registration = readFileSync(
      resolve("scripts/register-discovery-scheduler-tasks.ps1"),
      "utf8",
    );
    const removal = readFileSync(resolve("scripts/remove-discovery-scheduler-tasks.ps1"), "utf8");
    expect(registration).toContain("TS New Music Radar Recurring Discovery");
    expect(registration).toContain("TS New Music Radar Maintenance Window");
    expect(registration).toContain("System32\\conhost.exe");
    expect(registration).toContain("TSNewMusicRadar\\production-scheduler.env");
    expect(registration).not.toContain('Join-Path $repositoryRoot ".env"');
    expect(registration).toContain('--headless `"$node`" --env-file=');
    expect(registration).toContain('--import tsx `"$schedulerCli`" tick');
    expect(registration).toContain('--import tsx `"$maintenanceCli`"');
    expect(registration).not.toContain('New-ScheduledTaskAction -Execute "powershell.exe"');
    expect(registration).not.toContain("pnpm.cmd");
    expect(registration).not.toContain("cmd.exe");
    expect(registration).toContain("-MultipleInstances IgnoreNew");
    expect(registration).toContain("-StartWhenAvailable");
    expect(registration).toContain("-WakeToRun");
    expect(registration).toContain("-ExecutionTimeLimit (New-TimeSpan -Hours 4)");
    expect(registration).toContain('$schedulerTrigger.Id = "MinuteScheduler"');
    expect(registration).toContain('$maintenanceTriggers[2].Id = "ThursdayAppleWake"');
    expect(registration).toContain('$maintenanceTriggers[3].Id = "FridayCatchupWake"');
    expect(registration).not.toMatch(/CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN/);
    expect(removal).toContain("Unregister-ScheduledTask");
  });
});
