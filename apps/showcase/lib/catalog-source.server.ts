import generatedCatalog from "./generated-public-catalog.json";
import { buildPublicCatalogSnapshot, type PublicCatalogSnapshot } from "./public-catalog";
import { catalogAtDate } from "./catalog-dates";

// No database client, filesystem credentials, fetch, or ops imports.
// The build loads Neon once. Visitors and ISR read only the deployment snapshot.
export function loadPublicCatalog(
  options: { readonly environment?: NodeJS.ProcessEnv; readonly now?: number } = {},
): Promise<PublicCatalogSnapshot> {
  const environment = options.environment ?? process.env;
  const catalog = buildPublicCatalogSnapshot(generatedCatalog, {
    applyEditorial: environment.VERCEL !== "1",
  });
  return Promise.resolve(catalogAtDate(catalog, new Date(options.now ?? Date.now())));
}
