import { log } from "@radar/core";
import { parseArgs } from "./args";
import { DryRunOperationalError, runScan } from "./scan";
import { loadLocalEnvironment } from "./local-env";

try {
  loadLocalEnvironment();
  const options = parseArgs(process.argv.slice(2));
  await runScan(options);
} catch (error) {
  if (error instanceof DryRunOperationalError) {
    log("error", "scan.dry_run_report", error.summary);
  }
  log("error", "scan.failed", {
    error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown error",
  });
  process.exitCode = 1;
}
