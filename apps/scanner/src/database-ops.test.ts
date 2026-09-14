import { describe, expect, it } from "vitest";
import { postgresBackupCommand, postgresRestoreCommand, restoreDatabase } from "./database-ops";

describe("database operations", () => {
  it("uses a PostgreSQL custom-format backup through Docker Compose", () => {
    expect(postgresBackupCommand()).toEqual({
      args: ["compose", "exec", "-T", "db", "pg_dump", "-U", "radar", "-d", "radar", "-Fc"],
      executable: "docker",
    });
  });

  it("uses a clean, owner-neutral PostgreSQL restore", () => {
    expect(postgresRestoreCommand().args).toEqual(
      expect.arrayContaining([
        "pg_restore",
        "--clean",
        "--if-exists",
        "--no-owner",
        "--exit-on-error",
      ]),
    );
  });

  it("requires destructive restore confirmation before file access", async () => {
    await expect(restoreDatabase("missing.dump", false)).rejects.toThrow("--confirm-replace-data");
  });

  it("requires an existing custom-format filename", async () => {
    await expect(restoreDatabase("missing.dump", true)).rejects.toThrow("does not exist");
  });
});
