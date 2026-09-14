import { describe, expect, it } from "vitest";
import { parseDiscoveryBootstrapOptions } from "./discovery-bootstrap-cli";

describe("discovery bootstrap CLI", () => {
  it("requires an explicit campaign for transition and keeps status read-only", () => {
    expect(parseDiscoveryBootstrapOptions(["status"])).toEqual({ command: "status" });
    expect(() => parseDiscoveryBootstrapOptions(["transition"])).toThrow("requires --campaign");
    expect(() => parseDiscoveryBootstrapOptions(["activate"])).toThrow("requires --campaign");
    expect(
      parseDiscoveryBootstrapOptions([
        "transition",
        "--campaign",
        "5f462e9e-c3db-451c-b77c-378ab21e8a94",
      ]),
    ).toEqual({
      campaignId: "5f462e9e-c3db-451c-b77c-378ab21e8a94",
      command: "transition",
    });
    expect(
      parseDiscoveryBootstrapOptions([
        "activate",
        "--campaign",
        "5f462e9e-c3db-451c-b77c-378ab21e8a94",
      ]),
    ).toEqual({
      campaignId: "5f462e9e-c3db-451c-b77c-378ab21e8a94",
      command: "activate",
    });
  });
});
