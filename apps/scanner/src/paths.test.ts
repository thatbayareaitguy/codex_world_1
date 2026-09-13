import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applicationDataDirectory, backupDirectory, exportDirectory, logDirectory } from "./paths";

describe("application paths", () => {
  it("uses defaults when optional path variables are blank", () => {
    const environment = {
      APP_BACKUP_DIR: "",
      APP_DATA_DIR: "   ",
      APP_LOG_DIR: "",
      LOCALAPPDATA: join("C:", "LocalData"),
    };
    const dataDirectory = join(environment.LOCALAPPDATA, "TSNewMusicRadar");

    expect(applicationDataDirectory(environment)).toBe(dataDirectory);
    expect(backupDirectory(environment)).toBe(join(dataDirectory, "backups"));
    expect(logDirectory(environment)).toBe(join(dataDirectory, "logs"));
    expect(exportDirectory(environment)).toBe(join(dataDirectory, "exports"));
  });

  it("uses trimmed explicit path overrides", () => {
    const environment = {
      APP_BACKUP_DIR: " C:\\Radar\\Backups ",
      APP_DATA_DIR: " C:\\Radar\\Data ",
      APP_LOG_DIR: " C:\\Radar\\Logs ",
    };

    expect(applicationDataDirectory(environment)).toBe("C:\\Radar\\Data");
    expect(backupDirectory(environment)).toBe("C:\\Radar\\Backups");
    expect(logDirectory(environment)).toBe("C:\\Radar\\Logs");
  });
});
