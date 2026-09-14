import { loadLocalEnvironment } from "./local-env";
import { runWebSupervisor } from "./web-supervisor";

loadLocalEnvironment();

try {
  await runWebSupervisor();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Web supervision failed."}\n`);
  process.exitCode = 1;
}
