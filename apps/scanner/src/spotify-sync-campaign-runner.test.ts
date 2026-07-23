import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Spotify campaign Windows runner", () => {
  it("runs one scoped tick and configures non-overlapping temporary execution", () => {
    const runner = readFileSync(resolve("scripts/run-spotify-campaign-tick.ps1"), "utf8");
    const registration = readFileSync(
      resolve("scripts/register-spotify-campaign-task.ps1"),
      "utf8",
    );
    const cleanup = readFileSync(resolve("scripts/remove-spotify-campaign-task.ps1"), "utf8");

    expect(runner).toContain("pnpm.cmd spotify:campaign -- tick --campaign $CampaignId");
    expect(registration).toContain("TS New Music Radar Spotify Campaign 100");
    expect(registration).toContain("-MultipleInstances IgnoreNew");
    expect(registration).toContain("-RepetitionInterval (New-TimeSpan -Minutes 1)");
    expect(registration).toContain("-WakeToRun");
    expect(registration).not.toMatch(/CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN/);
    expect(cleanup).toContain("Unregister-ScheduledTask");
  });
});
