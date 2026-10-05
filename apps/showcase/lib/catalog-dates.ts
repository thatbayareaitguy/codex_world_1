import type { PublicCatalogSnapshot, PublicRelease } from "./public-catalog";

// Catalog release dates are date-only. UTC avoids server-local timezone differences.
export function catalogAtDate(catalog: PublicCatalogSnapshot, now: Date): PublicCatalogSnapshot {
  const today = now.toISOString().slice(0, 10);
  return {
    ...catalog,
    releases: catalog.releases.map((release) => ({
      ...release,
      status: release.releaseDate > today ? "upcoming" : "released",
    })),
  };
}

export function releasesThisWeek(
  releases: readonly PublicRelease[],
  now: Date,
): readonly PublicRelease[] {
  const today = now.toISOString().slice(0, 10);
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  return releases.filter(
    (release) =>
      release.releaseDate <= today &&
      release.firstDiscoveredDate <= today &&
      release.firstDiscoveredDate >= cutoff.toISOString().slice(0, 10),
  );
}
