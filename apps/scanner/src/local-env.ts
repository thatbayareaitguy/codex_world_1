import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadLocalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  path = environment.RADAR_ENV_FILE
    ? resolve(environment.RADAR_ENV_FILE)
    : resolve(process.cwd(), ".env"),
): NodeJS.ProcessEnv {
  if (!existsSync(path)) return environment;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || environment[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    environment[key] = value;
  }
  return environment;
}
