import { homedir } from "node:os";
import { join } from "node:path";

export function applicationDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.APP_DATA_DIR ??
    join(environment.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "TSNewMusicRadar")
  );
}

export function backupDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.APP_BACKUP_DIR ?? join(applicationDataDirectory(environment), "backups");
}

export function logDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.APP_LOG_DIR ?? join(applicationDataDirectory(environment), "logs");
}
