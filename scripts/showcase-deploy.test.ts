import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployShowcase } from "./showcase-deploy";
import { safeFailure } from "./showcase-diagnostics";

const mock = vi.hoisted(() => ({
  spawn: vi.fn<(command: string, args: string[], options: SpawnOptions) => Child>(),
  killTree: vi.fn(),
  stage: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mock.spawn, spawnSync: mock.killTree }));
vi.mock("./showcase-diagnostics", async (original) => ({
  ...(await original<object>()),
  publicationStage: mock.stage,
}));
class Child extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 12345;
  kill = vi.fn();
}
let children: Child[];
beforeEach(() => {
  vi.clearAllMocks();
  children = [];
  mock.spawn.mockImplementation(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("serialized Showcase deployment authentication", () => {
  it("waits for a serial whoami refresh before starting deployment and excludes secrets", async () => {
    for (const key of [
      "DATABASE_URL",
      "SHOWCASE_NEON_PUBLIC_DATABASE_URL",
      "SHOWCASE_NEON_PUBLISHER_DATABASE_URL",
      "SHOWCASE_NEON_OWNER_DATABASE_URL",
      "APPLE_MUSIC_PRIVATE_KEY",
      "SPOTIFY_CLIENT_SECRET",
      "VERCEL_TOKEN",
      "NODE_OPTIONS",
    ])
      vi.stubEnv(key, "synthetic-private-value");
    const operation = deployShowcase(Date.now() + 25 * 60_000);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(mock.spawn.mock.calls[0]![1].slice(1)).toEqual(["whoami", "--non-interactive"]);
    children[0]!.emit("close", 0, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    expect(mock.spawn.mock.calls[1]![1].slice(1)).toEqual([
      "deploy",
      "--prod",
      "--yes",
      "--non-interactive",
    ]);
    for (const call of mock.spawn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("synthetic-private-value");
      expect(call[2]).toMatchObject({ windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    }
    children[1]!.emit("close", 0, null);
    await operation;
    expect(mock.stage.mock.calls).toEqual([["deployment-auth"], ["deployment"]]);
  });
  it("does not upload or deploy after authentication failure", async () => {
    const operation = deployShowcase(Date.now() + 60_000);
    const result = operation.catch((error: unknown) => safeFailure(error));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.stderr.emit(
      "data",
      Buffer.from("The specified token is not valid. Use vercel login\nBearer synthetic-private"),
    );
    children[0]!.emit("close", 1, null);
    expect(await result).toMatchObject({ reason: "vercel-authentication", cliExitCode: 1 });
    expect(JSON.stringify(await result)).not.toContain("synthetic-private");
    expect(children).toHaveLength(1);
  });
  it("caps authentication at one minute and terminates its child", async () => {
    vi.useFakeTimers();
    const operation = deployShowcase(Date.now() + 25 * 60_000);
    const rejected = expect(operation).rejects.toThrow("Deployment deadline exceeded.");
    await vi.advanceTimersByTimeAsync(60_001);
    await rejected;
    expect(children).toHaveLength(1);
    expect(mock.killTree.mock.calls.length + children[0]!.kill.mock.calls.length).toBe(1);
    children[0]!.emit("close", null, "SIGTERM");
  });
  it("does not start commands after the shared deployment deadline", async () => {
    await expect(deployShowcase(Date.now() - 1)).rejects.toThrow(/deadline/);
    expect(mock.spawn).not.toHaveBeenCalled();
  });
  it("records a deployment exit code without persisting raw output", async () => {
    const operation = deployShowcase(Date.now() + 60_000);
    const result = operation.catch((error: unknown) => safeFailure(error));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.emit("close", 0, null);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[1]!.stderr.emit("data", Buffer.from("private arbitrary URL and token"));
    children[1]!.emit("close", 7, null);
    expect(await result).toMatchObject({ reason: "deployment-failed", cliExitCode: 7 });
    expect(JSON.stringify(await result)).not.toContain("private arbitrary");
  });
});
