import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initializeBudget,
  updateRuntimeDirectory,
  withUpdateBudget,
} from "./showcase-update-budget";
import { budgetLedgerSchema } from "./showcase-update-policy";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(resolve(tmpdir(), "showcase-budget-test-"));
  vi.stubEnv("LOCALAPPDATA", directory);
  await initializeBudget();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
const readLedger = async () =>
  budgetLedgerSchema.parse(
    JSON.parse(await readFile(resolve(updateRuntimeDirectory(), "transfer-budget.json"), "utf8")),
  );

describe("durable recovery budget", () => {
  it("reserves exactly one extra attempt while retaining the original lock", async () => {
    let escaped: (() => Promise<boolean>) | undefined;
    await withUpdateBudget("synthetic-slot", async (reserve) => {
      escaped = reserve;
      expect(await reserve()).toBe(true);
      expect(await reserve()).toBe(false);
      await expect(withUpdateBudget("other", async () => {})).rejects.toMatchObject({
        code: "EEXIST",
      });
    });
    expect(await escaped!()).toBe(false);
    const ledger = await readLedger();
    expect(ledger.reservations.map((r) => r.slot)).toEqual([
      "synthetic-slot",
      "synthetic-slot/recovery",
    ]);
    expect(ledger.reservations.reduce((sum, r) => sum + r.bytes, 0)).toBe(64_000_000);
  });
  it("does not reset quota on failure or repeat a scheduled slot", async () => {
    await expect(
      withUpdateBudget("failed-slot", async (reserve) => {
        await reserve();
        throw new Error("Synthetic failure");
      }),
    ).rejects.toThrow();
    const operation = vi.fn();
    await withUpdateBudget("failed-slot", operation);
    expect(operation).not.toHaveBeenCalled();
    expect((await readLedger()).reservations).toHaveLength(2);
  });
  it("refuses recovery at the rolling-attempt cap", async () => {
    const ledger = await readLedger();
    ledger.reservations = Array.from({ length: 7 }, () => ({
      at: new Date().toISOString(),
      bytes: 32_000_000,
      slot: "manual",
    }));
    await writeFile(
      resolve(updateRuntimeDirectory(), "transfer-budget.json"),
      JSON.stringify(ledger),
    );
    await expect(withUpdateBudget("manual", async (reserve) => reserve())).rejects.toThrow(/eight/);
    expect((await readLedger()).reservations).toHaveLength(8);
  });
});
