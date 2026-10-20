import { describe, expect, it } from "vitest";
import { deploymentFailure } from "./showcase-deployment-diagnostics";
import { safeFailure } from "./showcase-diagnostics";

describe("Vercel failure diagnostics", () => {
  it.each([
    ["Your token is expired. vercel login", "vercel-authentication"],
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
});
