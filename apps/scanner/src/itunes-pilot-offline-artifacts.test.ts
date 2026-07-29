import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOfflineArtifactIfChanged } from "./itunes-pilot-offline-artifacts";

describe("offline iTunes evaluation artifacts", () => {
  it("is idempotent when deterministic documentation content is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "itunes-offline-artifact-"));
    const path = join(directory, "nested", "evaluation.json");
    try {
      expect(await writeOfflineArtifactIfChanged(path, "deterministic\n")).toBe(true);
      const first = await stat(path);
      expect(await writeOfflineArtifactIfChanged(path, "deterministic\n")).toBe(false);
      const second = await stat(path);
      expect(second.mtimeMs).toBe(first.mtimeMs);
      expect(await readFile(path, "utf8")).toBe("deterministic\n");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
