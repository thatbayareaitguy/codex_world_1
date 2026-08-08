import { describe, expect, it } from "vitest";
import { nextWeeklyAppleScanAt } from "./discovery-schedule";

describe("weekly Apple discovery schedule", () => {
  it("uses the following Thursday at 9 PM Pacific for the first-week bootstrap", () => {
    expect(nextWeeklyAppleScanAt(new Date("2026-08-07T19:00:00.000Z")).toISOString()).toBe(
      "2026-08-14T04:00:00.000Z",
    );
  });

  it("keeps the local 9 PM schedule across daylight-saving changes", () => {
    expect(nextWeeklyAppleScanAt(new Date("2026-11-06T20:00:00.000Z")).toISOString()).toBe(
      "2026-11-13T05:00:00.000Z",
    );
  });
});
