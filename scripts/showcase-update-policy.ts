import { z } from "zod";
import {
  monthlyTransferBudgetBytes,
  weeklyTransferBudgetBytes,
  transferReservationBytes,
} from "../apps/showcase/lib/catalog-budget";

export const budgetLedgerSchema = z.object({
  version: z.literal(1),
  baselineMonth: z.string().regex(/^\d{4}-\d{2}$/),
  baselineBytes: z.number().int().nonnegative(),
  reservations: z.array(
    z.object({ at: z.iso.datetime(), bytes: z.number().int().positive(), slot: z.string() }),
  ),
});
export type BudgetLedger = z.infer<typeof budgetLedgerSchema>;

export function reserveUpdate(ledger: BudgetLedger, now: Date, slot: string): BudgetLedger {
  const month = now.toISOString().slice(0, 7);
  const recent = ledger.reservations.filter((r) => Date.parse(r.at) > now.getTime() - 7 * 86400000);
  const weekly = recent.reduce((sum, r) => sum + r.bytes, 0);
  const monthly =
    ledger.reservations.filter((r) => r.at.startsWith(month)).reduce((sum, r) => sum + r.bytes, 0) +
    (ledger.baselineMonth === month ? ledger.baselineBytes : 0);
  if (recent.length >= 8)
    throw new Error("Maximum eight update attempts per rolling seven days reached.");
  if (
    weekly + transferReservationBytes > weeklyTransferBudgetBytes ||
    monthly + transferReservationBytes > monthlyTransferBudgetBytes
  ) {
    throw new Error(
      "Transfer safety budget exhausted. Existing website remains online; refresh refused.",
    );
  }
  if (slot !== "manual" && ledger.reservations.some((r) => r.slot === slot))
    throw new Error("Scheduled slot already attempted.");
  return {
    ...ledger,
    reservations: [
      ...ledger.reservations,
      { at: now.toISOString(), bytes: transferReservationBytes, slot },
    ],
  };
}

export function scheduledSlot(now: Date): string | undefined {
  // Select the latest slot within 24h, including after sleep/logon. IANA timezone handles DST.
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let minutes = 0; minutes < 24 * 60; minutes++) {
    const candidate = new Date(now.getTime() - minutes * 60000);
    const parts = Object.fromEntries(format.formatToParts(candidate).map((p) => [p.type, p.value]));
    const time = `${parts.hour}:${parts.minute}`;
    if (
      (parts.weekday === "Fri" && time === "23:00") ||
      (parts.weekday === "Sat" && ["00:45", "11:00"].includes(time))
    ) {
      return `${parts.year}-${parts.month}-${parts.day}/${time}/America_Los_Angeles`;
    }
  }
  return undefined;
}
