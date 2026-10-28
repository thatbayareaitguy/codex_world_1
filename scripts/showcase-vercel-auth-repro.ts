// Offline diagnostic for the pinned, locally installed Vercel CLI 62.2.0.
// Uses only synthetic tokens, a temporary project link, and mocked global fetch.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const installation = resolve(".app-runtime/deployer/node_modules/vercel");
  const manifest: unknown = JSON.parse(
    await readFile(resolve(installation, "package.json"), "utf8"),
  );
  assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
  assert.equal(
    manifest.version,
    "62.2.0",
    "Review bundle exports before testing a different CLI version.",
  );
  const chunks = resolve(installation, "dist/chunks");
  interface CliClient {
    cwd: string;
    authConfig: { token?: string };
    persistAuthConfig: () => void;
    writeToConfigFile: () => void;
  }
  const { Client } = (await import(pathToFileURL(resolve(chunks, "chunk-DECIQZZQ.js")).href)) as {
    Client: new (options: Record<string, unknown>) => CliClient;
  };
  const { getLinkedProject } = (await import(
    pathToFileURL(resolve(chunks, "chunk-7IRKF3ZG.js")).href
  )) as {
    getLinkedProject: (client: CliClient, path: string) => Promise<{ status: string }>;
  };
  const { getUser } = (await import(pathToFileURL(resolve(chunks, "chunk-SM5JI6QM.js")).href)) as {
    getUser: (client: CliClient) => Promise<unknown>;
  };
  const directory = await mkdtemp(resolve(tmpdir(), "showcase-vercel-auth-repro-"));
  const link = { orgId: "team_synthetic", projectId: "prj_synthetic", projectName: "synthetic" };
  const originalFetch = globalThis.fetch;
  const originalDirectory = process.cwd();
  let refreshes = 0;
  let rejected = 0;

  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      const issuer = new URL("../", url).href;
      return Response.json({
        issuer,
        device_authorization_endpoint: issuer + "device",
        token_endpoint: issuer + "token",
        revocation_endpoint: issuer + "revoke",
        jwks_uri: issuer + "jwks",
        introspection_endpoint: issuer + "inspect",
      });
    }
    if (url.pathname.endsWith("/token")) {
      refreshes++;
      if (refreshes > 1) return Response.json({ error: "invalid_grant" }, { status: 400 });
      // Rejected parallel refresh completes first, reproducing a failed request
      // while the successful refresh still persists a token usable on the next run.
      await new Promise((done) => setTimeout(done, 40));
      return Response.json({
        access_token: "synthetic-fresh",
        refresh_token: "synthetic-rotated",
        token_type: "Bearer",
        expires_in: 28800,
      });
    }
    if (new Headers(init?.headers).get("authorization") !== "Bearer synthetic-fresh") {
      rejected++;
      return Response.json(
        { error: { code: "forbidden", message: "Synthetic invalid token", invalidToken: true } },
        { status: 403 },
      );
    }
    if (url.pathname === "/v2/user")
      return Response.json({
        user: { id: "synthetic-user", username: "synthetic", version: "northstar" },
      });
    if (/\/teams\//.test(url.pathname))
      return Response.json({ id: link.orgId, slug: "synthetic-team", name: "Synthetic Team" });
    if (/\/projects\//.test(url.pathname))
      return Response.json({
        id: link.projectId,
        accountId: link.orgId,
        name: "synthetic",
        rootDirectory: "apps/showcase",
      });
    throw new Error("Unmocked request blocked. No real network is permitted.");
  };

  try {
    await mkdir(resolve(directory, ".vercel"));
    await writeFile(resolve(directory, ".vercel/project.json"), JSON.stringify(link));
    for (const preflight of [false, true]) {
      refreshes = 0;
      rejected = 0;
      const client = new Client({
        argv: ["node", "vercel", "deploy", "--prod", "--yes"],
        apiUrl: "https://api.vercel.com",
        authConfig: { token: "synthetic-expired", refreshToken: "synthetic-refresh", expiresAt: 0 },
        config: { currentTeam: link.orgId },
        stdin: { isTTY: false },
        stdout: process.stdout,
        stderr: process.stderr,
        telemetryEventStore: {
          currentSessionId: "synthetic",
          currentInvocationId: "synthetic",
          updateUserId() {},
        },
      });
      client.cwd = directory;
      // Never read or write the real CLI authentication/configuration store.
      client.persistAuthConfig = () => {};
      client.writeToConfigFile = () => {};
      let outcome;
      try {
        if (preflight) await getUser(client);
        outcome = (await getLinkedProject(client, directory)).status;
      } catch (error) {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "NOT_AUTHORIZED");
        outcome = "NOT_AUTHORIZED";
      }
      const result = {
        preflight,
        outcome,
        refreshes,
        rejected,
        hasFreshToken: client.authConfig.token === "synthetic-fresh",
      };
      assert.deepEqual(
        result,
        preflight
          ? { preflight: true, outcome: "linked", refreshes: 1, rejected: 0, hasFreshToken: true }
          : {
              preflight: false,
              outcome: "NOT_AUTHORIZED",
              refreshes: 2,
              rejected: 1,
              hasFreshToken: true,
            },
      );
      console.log(JSON.stringify(result));
    }
  } finally {
    globalThis.fetch = originalFetch;
    // The CLI's cwd setter changes the process directory as well.
    process.chdir(originalDirectory);
    // Exact mkdtemp-owned directory containing synthetic fixtures only.
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
