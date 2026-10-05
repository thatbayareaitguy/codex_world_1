import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { budgetLedgerSchema, reserveUpdate, type BudgetLedger } from "./showcase-update-policy";

export function updateRuntimeDirectory(): string {
  if (!process.env.LOCALAPPDATA) throw new Error("LOCALAPPDATA is required.");
  return resolve(process.env.LOCALAPPDATA, "Showcase", "publication");
}

export async function withUpdateBudget<T>(
  slot: string,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const directory = updateRuntimeDirectory();
  await mkdir(directory, { recursive: true });
  const lockPath = resolve(directory, "update.lock");
  const lock = await open(lockPath, "wx");
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const ledgerPath = resolve(directory, "transfer-budget.json");
    const ledger = budgetLedgerSchema.parse(JSON.parse(await readFile(ledgerPath, "utf8")));
    if (slot !== "manual" && ledger.reservations.some((r) => r.slot === slot)) return undefined;
    const next = reserveUpdate(ledger, new Date(), slot);
    await writeFile(`${ledgerPath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(`${ledgerPath}.tmp`, ledgerPath);
    // Reserve before any network operation. Failures also consume the allowance.
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function initializeBudget(): Promise<void> {
  const directory = updateRuntimeDirectory();
  await mkdir(directory, { recursive: true });
  const ledger: BudgetLedger = {
    version: 1,
    baselineMonth: "2026-10",
    baselineBytes: 2_000_000_000,
    reservations: [],
  };
  // Never silently recreate/reset accounting during a scheduled run.
  await writeFile(
    resolve(directory, "transfer-budget.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}
