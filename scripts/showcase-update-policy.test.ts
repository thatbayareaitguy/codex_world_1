import { describe, expect, it } from "vitest";
import { reserveUpdate, scheduledSlot, type BudgetLedger } from "./showcase-update-policy";
import { samePublication, validatePublicationChange } from "./showcase-publication-safety";
import { publicCatalog } from "../apps/showcase/lib/public-catalog";
import { transferReservationBytes } from "../apps/showcase/lib/catalog-budget";

const now = new Date("2026-10-04T20:00:00Z");
const ledger: BudgetLedger = {
  version: 1,
  baselineMonth: "2026-10",
  baselineBytes: 2_000_000_000,
  reservations: [],
};
describe("Showcase publication budget and schedule", () => {
  it("reserves before an attempt and includes the rounded-up October usage", () => {
    expect(reserveUpdate(ledger, now, "manual").reservations[0]?.bytes).toBe(
      transferReservationBytes,
    );
    expect(() => reserveUpdate({ ...ledger, baselineBytes: 3_490_000_000 }, now, "manual")).toThrow(
      /budget exhausted/,
    );
  });
  it("enforces a rolling week across calendar months", () => {
    const full = {
      ...ledger,
      reservations: [{ at: "2026-09-30T20:00:00Z", bytes: 740_000_000, slot: "old" }],
    };
    expect(() => reserveUpdate(full, now, "manual")).toThrow(/budget exhausted/);
  });
  it("allows a new monthly allowance without forgetting recent weekly spending", () => {
    expect(
      reserveUpdate(
        { ...ledger, baselineBytes: 3_500_000_000 },
        new Date("2026-11-01T00:00:00Z"),
        "manual",
      ).reservations,
    ).toHaveLength(1);
  });
  it("refuses duplicate scheduled runs and retry storms", () => {
    const once = reserveUpdate(ledger, now, "friday");
    expect(() => reserveUpdate(once, now, "friday")).toThrow(/already attempted/);
    let next = ledger;
    for (let i = 0; i < 8; i++) next = reserveUpdate(next, now, "manual");
    expect(() => reserveUpdate(next, now, "manual")).toThrow(/eight/);
  });
  it("uses Pacific time with DST and expires missed slots after 24h", () => {
    expect(scheduledSlot(new Date("2026-10-10T06:00:00Z"))).toContain("2026-10-09/23:00");
    expect(scheduledSlot(new Date("2026-11-07T07:00:00Z"))).toContain("2026-11-06/23:00");
    expect(scheduledSlot(new Date("2026-10-10T07:45:00Z"))).toContain("00:45");
    expect(scheduledSlot(new Date("2026-10-10T18:00:00Z"))).toContain("11:00");
    expect(scheduledSlot(new Date("2026-10-12T18:00:00Z"))).toBeUndefined();
  });
  it("skips timestamp-only versions but notices content changes", () => {
    expect(
      samePublication(publicCatalog, { ...publicCatalog, generatedAt: now.toISOString() }),
    ).toBe(true);
    expect(samePublication(publicCatalog, { ...publicCatalog, artists: [] })).toBe(false);
  });
  it("rejects empty catalogs, suspicious drops and broken artist links", () => {
    expect(() =>
      validatePublicationChange(publicCatalog, { ...publicCatalog, releases: [] }),
    ).toThrow(/empty/);
    expect(() =>
      validatePublicationChange(publicCatalog, {
        ...publicCatalog,
        artists: publicCatalog.artists.slice(0, 10),
      }),
    ).toThrow(/10%/);
    expect(() =>
      validatePublicationChange(publicCatalog, {
        ...publicCatalog,
        releases: publicCatalog.releases.map((r) => ({
          ...r,
          artistCredits: [{ name: "Missing", artistSlug: "missing" }],
        })),
      }),
    ).toThrow(/reference/);
  });
});
