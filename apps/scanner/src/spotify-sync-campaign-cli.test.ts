import { describe, expect, it } from "vitest";
import { parseSpotifySyncCampaignOptions } from "./spotify-sync-campaign-cli";

describe("Spotify sync campaign CLI", () => {
  it("parses bounded creation and requires campaign IDs for controls", () => {
    expect(
      parseSpotifySyncCampaignOptions([
        "create",
        "--target",
        "100",
        "--canary",
        "10",
        "--deadline-hours",
        "8",
      ]),
    ).toEqual({ canary: 10, command: "create", deadlineHours: 8, target: 100 });
    expect(() => parseSpotifySyncCampaignOptions(["tick"])).toThrow(
      "tick requires --campaign <id>",
    );
    expect(parseSpotifySyncCampaignOptions(["tick", "--campaign", "campaign-id"]).campaignId).toBe(
      "campaign-id",
    );
    expect(
      parseSpotifySyncCampaignOptions([
        "resume",
        "--campaign",
        "campaign-id",
        "--deadline-hours",
        "24",
      ]),
    ).toMatchObject({
      campaignId: "campaign-id",
      command: "resume",
      deadlineHours: 24,
    });
  });
});
