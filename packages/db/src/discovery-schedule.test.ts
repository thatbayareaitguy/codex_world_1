import { describe, expect, it } from "vitest";
import {
  discoveryAppleCatchupHour,
  discoveryAppleFullHour,
  nextAppleCatchupScanAt,
  nextWeeklyAppleScanAt,
} from "./discovery-schedule";

describe("recurring discovery calendar", () => {
  it("schedules the Thursday full scan at 9 PM America/Los_Angeles", () => {
    expect(discoveryAppleFullHour).toBe(21);
    expect(nextWeeklyAppleScanAt(new Date("2026-08-12T20:00:00.000Z"))).toEqual(
      new Date("2026-08-14T04:00:00.000Z"),
    );
  });

  it("schedules the Friday catch-up at 9 AM America/Los_Angeles", () => {
    expect(discoveryAppleCatchupHour).toBe(9);
    expect(nextAppleCatchupScanAt(new Date("2026-08-13T20:00:00.000Z"))).toEqual(
      new Date("2026-08-14T16:00:00.000Z"),
    );
  });

  it("preserves local wall-clock times across daylight-saving changes", () => {
    expect(nextWeeklyAppleScanAt(new Date("2026-10-31T20:00:00.000Z"))).toEqual(
      new Date("2026-11-06T05:00:00.000Z"),
    );
    expect(nextAppleCatchupScanAt(new Date("2026-10-31T20:00:00.000Z"))).toEqual(
      new Date("2026-11-06T17:00:00.000Z"),
    );
  });
});
