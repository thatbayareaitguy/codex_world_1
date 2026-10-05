import generatedCatalog from "../../../lib/generated-public-catalog.json";
import { catalogContentSha256 } from "../../../lib/catalog-integrity";

export const dynamic = "force-static";

export function GET() {
  return Response.json({
    source: "deployment-snapshot",
    generatedAt: generatedCatalog.generatedAt,
    contentSha256: catalogContentSha256(generatedCatalog),
    artists: generatedCatalog.artists.length,
    releases: generatedCatalog.releases.length,
    genres: generatedCatalog.genres.length,
    runtimeDatabaseReads: 0,
  });
}
