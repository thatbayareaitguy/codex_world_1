import { log } from "@radar/core";
import { parseArgs } from "./args";
import { runScan } from "./scan";

try {
  const options = parseArgs(process.argv.slice(2));
  await runScan(options);
} catch (error) {
  log("error", "scan.failed", {
    error: error instanceof Error ? { name: error.name, message: error.message } : "Unknown error",
  });
  process.exitCode = 1;
}
