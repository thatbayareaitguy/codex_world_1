import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderExecutionBudget {
  signal: AbortSignal;
  reserveCapacityWait(milliseconds: number): void;
}

const executionBudget = new AsyncLocalStorage<ProviderExecutionBudget>();

/** Request-local cancellation, shared by API, OAuth, gates, and nested pagination. */
export function withProviderExecutionBudget<T>(budget: ProviderExecutionBudget, run: () => T): T {
  return executionBudget.run(budget, run);
}

export function providerExecutionSignal(signal?: AbortSignal): AbortSignal | undefined {
  const inherited = executionBudget.getStore()?.signal;
  const combined =
    inherited && signal ? AbortSignal.any([inherited, signal]) : (inherited ?? signal);
  combined?.throwIfAborted();
  return combined;
}

export function reserveProviderCapacityWait(milliseconds: number): void {
  providerExecutionSignal();
  executionBudget.getStore()?.reserveCapacityWait(milliseconds);
}

export function providerCancellableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal = providerExecutionSignal(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason instanceof Error ? signal.reason : new Error("Provider execution aborted."),
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
