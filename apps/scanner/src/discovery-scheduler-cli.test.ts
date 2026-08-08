import { describe, expect, it } from "vitest";
import { parseDiscoverySchedulerCommand } from "./discovery-scheduler-cli";

describe("discovery scheduler command", () => {
  it("accepts only status and tick", () => {
    expect(parseDiscoverySchedulerCommand(["status"])).toBe("status");
    expect(parseDiscoverySchedulerCommand(["--", "tick"])).toBe("tick");
    expect(() => parseDiscoverySchedulerCommand(["run"])).toThrow(/Usage/);
  });
});
