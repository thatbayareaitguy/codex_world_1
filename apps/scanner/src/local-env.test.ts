import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnvironment } from "./local-env";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local environment loading", () => {
  it("loads an explicitly isolated RADAR_ENV_FILE without requiring .env", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-itunes-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "itunes.env");
    writeFileSync(
      path,
      [
        "DATABASE_URL=postgres://radar:radar@127.0.0.1:55433/radar_itunes",
        "SPOTIFY_ENABLED=false",
        "ITUNES_DISCOVERY_ENABLED=false",
      ].join("\n"),
    );
    const environment = loadLocalEnvironment({ RADAR_ENV_FILE: path });
    expect(environment).toMatchObject({
      DATABASE_URL: "postgres://radar:radar@127.0.0.1:55433/radar_itunes",
      ITUNES_DISCOVERY_ENABLED: "false",
      SPOTIFY_ENABLED: "false",
    });
  });

  it("does not overwrite environment values already provided by the operator", () => {
    const directory = mkdtempSync(join(tmpdir(), "radar-itunes-env-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "itunes.env");
    writeFileSync(path, "SPOTIFY_ENABLED=true\n");
    const environment = loadLocalEnvironment({
      RADAR_ENV_FILE: path,
      SPOTIFY_ENABLED: "false",
    });
    expect(environment.SPOTIFY_ENABLED).toBe("false");
  });
});
