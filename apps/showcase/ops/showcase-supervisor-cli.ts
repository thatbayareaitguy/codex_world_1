import { runShowcaseSupervisor } from "./showcase-supervisor";

runShowcaseSupervisor().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Showcase supervisor failed.");
  process.exitCode = 1;
});
