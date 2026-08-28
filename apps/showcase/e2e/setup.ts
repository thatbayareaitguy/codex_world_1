import { rm } from "node:fs/promises";
import { resolve } from "node:path";

export default async function setupShowcaseE2e(): Promise<void> {
  const runtimeDirectory = resolve("apps", "showcase", ".app-runtime");
  await Promise.all([
    rm(resolve(runtimeDirectory, "e2e-confirmed-genres.json"), { force: true }),
    rm(resolve(runtimeDirectory, "e2e-genre-reviews.json"), { force: true }),
  ]);
}
