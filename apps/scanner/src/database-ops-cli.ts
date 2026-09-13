import { backupDatabase, restoreDatabase } from "./database-ops";
import { loadLocalEnvironment } from "./local-env";

loadLocalEnvironment();
const [operation, ...args] = process.argv.slice(2);
try {
  if (operation === "backup") {
    const path = await backupDatabase();
    process.stdout.write(`Backup completed: ${path}\n`);
  } else if (operation === "restore") {
    const fileIndex = args.indexOf("--file");
    const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined;
    if (!file) throw new Error("Restore requires --file <path>.");
    await restoreDatabase(file, args.includes("--confirm-replace-data"));
    process.stdout.write("Restore completed. Run pnpm db:migrate and pnpm doctor.\n");
  } else {
    throw new Error("Expected backup or restore operation.");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Database operation failed."}\n`,
  );
  process.exitCode = 1;
}
