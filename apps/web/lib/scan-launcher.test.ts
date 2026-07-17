import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchScanNow } from "./scan-launcher";

describe("on-demand scan launcher", () => {
  it("starts the existing scanner command without opening a Windows console", async () => {
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      unref,
    }) as unknown as ChildProcess;
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    const pnpmRuntime = resolve("synthetic", "pnpm.cjs");

    const result = await launchScanNow(
      spawnProcess,
      { NODE_ENV: "test", npm_execpath: pnpmRuntime },
      resolve(process.cwd(), "apps", "web"),
    );

    expect(result).toEqual({ pid: 4242 });
    expect(spawnProcess).toHaveBeenCalledWith(
      process.execPath,
      [pnpmRuntime, "scan"],
      expect.objectContaining({
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
      }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
