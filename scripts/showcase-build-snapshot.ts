import { writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPublishedCatalog } from "./showcase-neon-reader";

// Exactly once before next build, never inside a Next.js worker or request.
// Failure rejects the deployment; Vercel keeps its previous deployment live.
async function main(): Promise<void> {
  if (process.env.VERCEL !== "1" && process.env.SHOWCASE_BUILD_FROM_NEON !== "true") return;
  try {
    const catalog = await readPublishedCatalog();
    const path = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../apps/showcase/lib/generated-public-catalog.json",
    );
    await writeFile(`${path}.build.tmp`, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
    await rename(`${path}.build.tmp`, path);
    console.info(
      "Showcase: one bounded Neon read completed; website runtime performs zero database reads.",
    );
  } catch {
    console.error(
      "Showcase build snapshot failed. Existing deployment is unchanged. Check Neon availability and the read-only build credential.",
    );
    process.exitCode = 1;
  }
}

void main();
