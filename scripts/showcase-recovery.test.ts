import { describe, expect, it, vi } from "vitest";
import { isRecoverable, publishAndVerify, recoverOnce } from "./showcase-recovery";

const disconnected = () =>
  Object.assign(new Error("Synthetic connection failure"), { code: "ECONNRESET" });
describe("bounded post-publication recovery", () => {
  it("reserves before a transient retry, and never loops", async () => {
    const events: string[] = [];
    const operation = vi.fn(() => {
      events.push("operation");
      return Promise.reject(disconnected());
    });
    const reserve = vi.fn(() => {
      events.push("reserve");
      return Promise.resolve(true);
    });
    await expect(
      recoverOnce("neon-readback", operation, reserve, () => Promise.resolve()),
    ).rejects.toThrow();
    expect(events).toEqual(["operation", "reserve", "operation"]);
    expect(reserve).toHaveBeenCalledOnce();
  });
  it("does not retry when the shared recovery allowance or budget is exhausted", async () => {
    const operation = vi.fn(() => Promise.reject(disconnected()));
    await expect(
      recoverOnce("neon-readback", operation, () => Promise.resolve(false)),
    ).rejects.toThrow();
    expect(operation).toHaveBeenCalledOnce();
    operation.mockClear();
    await expect(
      recoverOnce("neon-readback", operation, () => Promise.reject(new Error("Budget exhausted"))),
    ).rejects.toThrow("Budget exhausted");
    expect(operation).toHaveBeenCalledOnce();
  });
  it("does not retry integrity, authentication, build or scanner-readiness failures", () => {
    for (const message of [
      "Neon round-trip verification failed.",
      "Vercel authentication failed.",
      "Vercel build failed.",
      "Apple scan is active or not fresh enough; publication deferred.",
    ])
      expect(isRecoverable(new Error(message))).toBe(false);
  });
  it("recovers a lost write acknowledgement by verifying, never by publishing again", async () => {
    const write = vi.fn(() => Promise.reject(disconnected()));
    const verify = vi.fn(() => Promise.resolve());
    const reserve = vi.fn(() => Promise.resolve(true));
    await publishAndVerify({ write, verify, reserve });
    expect(write).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
  });
  it("rejects an unverified ambiguous write instead of duplicating it", async () => {
    const write = vi.fn(() => Promise.reject(disconnected()));
    const verify = vi.fn(() => Promise.reject(new Error("Neon round-trip verification failed.")));
    await expect(
      publishAndVerify({ write, verify, reserve: () => Promise.resolve(true) }),
    ).rejects.toThrow(/round-trip/);
    expect(write).toHaveBeenCalledOnce();
  });
});
