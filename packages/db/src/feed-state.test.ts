import { describe, expect, it } from "vitest";
import { productionCalendarDate } from "./feed-state";

describe("productionCalendarDate", () => {
  it("uses the Pacific calendar boundary", () => {
    expect(productionCalendarDate(new Date("2026-08-28T06:59:59.000Z"))).toBe("2026-08-27");
    expect(productionCalendarDate(new Date("2026-08-28T07:00:00.000Z"))).toBe("2026-08-28");
  });

  it("handles the Pacific daylight-saving transition", () => {
    expect(productionCalendarDate(new Date("2026-11-01T06:59:59.000Z"))).toBe("2026-10-31");
    expect(productionCalendarDate(new Date("2026-11-01T08:00:00.000Z"))).toBe("2026-11-01");
  });
});
