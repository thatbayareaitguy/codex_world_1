import { describe, expect, it } from "vitest";
import { deploymentFailure } from "./showcase-deployment-diagnostics";
import { safeFailure } from "./showcase-diagnostics";

describe("Vercel failure diagnostics", () => {
  it.each([
    ["Your token is expired. vercel login", "vercel-authentication"],
    ["The specified token is not valid.", "vercel-authentication"],
    ["Error: NOT_AUTHORIZED", "vercel-authentication"],
    ["Error: invalid_grant", "vercel-authentication"],
    [
      "Use \u001b[1mvercel\u001b[0m \u001b[1mlogin\u001b[0m to generate a new token.",
      "vercel-authentication",
    ],
    ["File size limit exceeded (100 MB)", "vercel-upload-limit"],
    ["Command build exited with 1", "vercel-build-failed"],
    ["fetch failed ECONNRESET", "vercel-network"],
    ["Something unrecognized", "deployment-failed"],
  ])("classifies %s without storing arbitrary output", (text, reason) => {
    const failure = safeFailure(
      deploymentFailure(`${text}\nAuthorization: Bearer synthetic-private-token`),
    );
    expect(failure.reason).toBe(reason);
    expect(JSON.stringify(failure)).not.toContain("synthetic-private-token");
  });
  it("only records bounded numeric exit codes and known process signals", () => {
    expect(
      safeFailure(deploymentFailure("unknown", { exitCode: 7, signal: "SIGTERM" })),
    ).toMatchObject({ cliExitCode: 7, cliSignal: "SIGTERM" });
    const safe = safeFailure(
      deploymentFailure("unknown", { exitCode: Infinity, signal: "private-token" }),
    );
    expect(safe).not.toHaveProperty("cliExitCode");
    expect(safe).not.toHaveProperty("cliSignal");
  });
});
