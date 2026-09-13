import { describe, expect, it, vi } from "vitest";
import { waitForMaintenanceDatabase } from "./maintenance-readiness";
import type {
  MaintenanceDatabaseReadinessError,
  MaintenanceReadinessAttempt,
} from "./maintenance-readiness";

describe("maintenance database readiness", () => {
  it("retries a thirty-second wake delay and returns the first healthy connection", async () => {
    const result = await simulateReadiness({ healthyAtMs: 30_000, retryIntervalMs: 10_000 });
    expect(result.connection.id).toBe(4);
    expect(result.attempts).toHaveLength(4);
    expect(result.attempts.at(-1)).toMatchObject({
      dockerAvailability: "healthy",
      elapsedMs: 30_000,
      postgresReady: true,
    });
    expect(result.close).toHaveBeenCalledTimes(3);
  });

  it("holds a bounded readiness loop for several minutes without provider work", async () => {
    const result = await simulateReadiness({ healthyAtMs: 4 * 60_000, retryIntervalMs: 30_000 });
    expect(result.attempts.at(-1)).toMatchObject({
      elapsedMs: 4 * 60_000,
      postgresReady: true,
    });
    expect(result.probe).toHaveBeenCalledTimes(9);
  });

  it("fails after the ten-minute boundary and closes every failed connection", async () => {
    let clock = Date.parse("2026-09-08T15:50:00.000Z");
    const attempts: MaintenanceReadinessAttempt[] = [];
    const close = vi.fn(() => Promise.resolve());
    const open = vi.fn(() => ({ id: open.mock.calls.length }));
    await expect(
      waitForMaintenanceDatabase({
        close,
        inspectDocker: () => Promise.resolve("running"),
        now: () => new Date(clock),
        open,
        probe: () => Promise.reject(Object.assign(new Error("offline"), { code: "ECONNREFUSED" })),
        record: (attempt) => attempts.push(attempt),
        retryIntervalMs: 60_000,
        sleep: (milliseconds) => {
          clock += milliseconds;
          return Promise.resolve();
        },
        timeoutMs: 10 * 60_000,
      }),
    ).rejects.toMatchObject({
      attempts: 11,
      elapsedMs: 10 * 60_000,
    } satisfies Partial<MaintenanceDatabaseReadinessError>);
    expect(close).toHaveBeenCalledTimes(11);
    expect(attempts.at(-1)).toMatchObject({
      errorClassification: "ECONNREFUSED",
      postgresReady: false,
    });
  });
});

async function simulateReadiness(input: { healthyAtMs: number; retryIntervalMs: number }) {
  const startedAt = Date.parse("2026-09-08T15:50:00.000Z");
  let clock = startedAt;
  const attempts: MaintenanceReadinessAttempt[] = [];
  const close = vi.fn(() => Promise.resolve());
  const open = vi.fn(() => ({ id: open.mock.calls.length }));
  const probe = vi.fn(() =>
    clock - startedAt >= input.healthyAtMs
      ? Promise.resolve()
      : Promise.reject(Object.assign(new Error("offline"), { code: "ECONNREFUSED" })),
  );
  const connection = await waitForMaintenanceDatabase({
    close,
    inspectDocker: () =>
      Promise.resolve(clock - startedAt >= input.healthyAtMs ? "healthy" : "running"),
    now: () => new Date(clock),
    open,
    probe,
    record: (attempt) => attempts.push(attempt),
    retryIntervalMs: input.retryIntervalMs,
    sleep: (milliseconds) => {
      clock += milliseconds;
      return Promise.resolve();
    },
    timeoutMs: 10 * 60_000,
  });
  return { attempts, close, connection, probe };
}
