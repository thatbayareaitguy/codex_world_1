import { beforeEach, describe, expect, it, vi } from "vitest";
import { publicCatalog } from "../apps/showcase/lib/public-catalog";
import { catalogContentSha256 } from "../apps/showcase/lib/catalog-integrity";
import { readPublishedCatalog } from "./showcase-neon-reader";

const mock = vi.hoisted(() => ({
  query: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(),
  end: vi.fn(),
}));
vi.mock("postgres", () => ({ default: () => Object.assign(mock.query, { end: mock.end }) }));
const environment = {
  SHOWCASE_NEON_PUBLIC_DATABASE_URL:
    "postgresql://showcase_web_readonly:synthetic@ep-fixture-pooler.us-west-2.aws.neon.tech/neondb?sslmode=require",
};
beforeEach(() => {
  mock.query.mockReset();
  mock.end.mockReset();
});
describe("bounded deployment catalog read", () => {
  it("reads one validated snapshot with a server-side byte cap", async () => {
    mock.query.mockResolvedValue([
      {
        catalog_version: "1",
        contract_version: "showcase-public-v3",
        content_sha256: catalogContentSha256(publicCatalog),
        catalog: publicCatalog,
      },
    ]);
    expect(await readPublishedCatalog({ environment })).toEqual(publicCatalog);
    expect(mock.query).toHaveBeenCalledTimes(1);
    expect(mock.query.mock.calls[0]?.[0].join("")).toContain(
      "CASE WHEN octet_length(catalog::text)",
    );
    expect(mock.query.mock.calls[0]?.[1]).toBe(8_000_000);
    expect(mock.end).toHaveBeenCalledOnce();
  });
  it("fails closed on oversized, corrupt, or unavailable snapshots", async () => {
    mock.query.mockResolvedValue([
      { catalog_version: "1", contract_version: "showcase-public-v3", catalog: null },
    ]);
    await expect(readPublishedCatalog({ environment })).rejects.toThrow(/8 MB/);
    mock.query.mockResolvedValue([
      {
        catalog_version: "1",
        contract_version: "showcase-public-v3",
        content_sha256: "bad",
        catalog: publicCatalog,
      },
    ]);
    await expect(readPublishedCatalog({ environment })).rejects.toThrow(/integrity/);
    mock.query.mockRejectedValue(new Error("Synthetic unavailable database"));
    await expect(readPublishedCatalog({ environment })).rejects.toThrow(/unavailable/);
    expect(mock.end).toHaveBeenCalledTimes(3);
  });
});
