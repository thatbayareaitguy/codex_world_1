import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { claimSupervisorPid, clearStalePidFile, parsePid, restartDelayMs } from "./web-supervisor";

describe("web supervisor", () => {
  it("parses only safe positive process IDs", () => {
    expect(parsePid("79372\n")).toBe(79372);
    expect(parsePid("0")).toBeUndefined();
    expect(parsePid("not-a-pid")).toBeUndefined();
  });

  it("removes dead and invalid PID records without deleting a live record", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-web-supervisor-"));
    const pidPath = join(directory, "web.pid");

    writeFileSync(pidPath, "79372", "utf8");
    expect(clearStalePidFile(pidPath, () => false)).toBe(true);

    writeFileSync(pidPath, "invalid", "utf8");
    expect(clearStalePidFile(pidPath, () => true)).toBe(true);

    writeFileSync(pidPath, "42", "utf8");
    expect(clearStalePidFile(pidPath, () => true)).toBe(false);
    expect(readFileSync(pidPath, "utf8")).toBe("42");
  });

  it("uses bounded restart backoff", () => {
    expect(restartDelayMs(1)).toBe(5_000);
    expect(restartDelayMs(3)).toBe(15_000);
    expect(restartDelayMs(100)).toBe(30_000);
  });

  it("claims one supervisor and safely replaces a dead supervisor record", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-web-supervisor-lock-"));
    const pidPath = join(directory, "web-supervisor.pid");

    expect(claimSupervisorPid(pidPath, 101, () => true)).toBe(true);
    expect(claimSupervisorPid(pidPath, 202, () => true)).toBe(false);
    expect(claimSupervisorPid(pidPath, 202, () => false)).toBe(true);
    expect(readFileSync(pidPath, "utf8")).toBe("202");
  });

  it("registers a direct, hidden, non-overlapping logon task with an awake-only watchdog", () => {
    const registration = readFileSync(resolve("scripts", "register-web-startup-task.ps1"), "utf8");
    const removal = readFileSync(resolve("scripts", "remove-web-startup-task.ps1"), "utf8");

    expect(registration).toContain("TS New Music Radar Web Application");
    expect(registration).toContain("System32\\conhost.exe");
    expect(registration).toContain('--headless `"$node`" --import tsx');
    expect(registration).toContain("web-supervisor-cli.ts");
    expect(registration).toContain("New-ScheduledTaskTrigger -AtLogOn");
    expect(registration).toContain("-RepetitionInterval (New-TimeSpan -Minutes 5)");
    expect(registration).toContain('$logonTrigger.Id = "WebAtLogon"');
    expect(registration).toContain('$watchdogTrigger.Id = "WebWatchdog"');
    expect(registration).toContain("-MultipleInstances IgnoreNew");
    expect(registration).toContain("-StartWhenAvailable");
    expect(registration).toContain("-RestartCount 3");
    expect(registration).toContain("-RestartInterval");
    expect(registration).toContain("-Hidden");
    expect(registration).not.toContain("-WakeToRun");
    expect(registration).not.toMatch(/--headless[^\n]*(?:powershell|pnpm\.cmd|cmd\.exe|\.ps1)/i);
    expect(registration).not.toMatch(/CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN/);
    expect(removal).toContain("Stop-ScheduledTask");
    expect(removal).toContain("Unregister-ScheduledTask");
  });
});
