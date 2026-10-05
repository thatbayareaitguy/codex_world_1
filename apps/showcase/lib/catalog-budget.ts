// Decimal GB, matching the budgeting units shown in the Neon console.
// Traffic from public visitors never spends this budget: only bounded publication reads do.
export const maximumCatalogBytes = 8_000_000;
export const weeklyTransferBudgetBytes = 750_000_000;
export const monthlyTransferBudgetBytes = 3_500_000_000;
// Three bounded reads (prior snapshot, readback, cloud build) plus 8 MB overhead.
export const transferReservationBytes = 32_000_000;

export function contentForComparison<T extends { readonly generatedAt: string }>(catalog: T) {
  return Object.fromEntries(Object.entries(catalog).filter(([key]) => key !== "generatedAt"));
}
