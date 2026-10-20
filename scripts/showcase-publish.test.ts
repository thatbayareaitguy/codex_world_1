import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import generated from "../apps/showcase/lib/generated-public-catalog.json";
import { publishShowcaseCatalog } from "./showcase-publish";

const mock = vi.hoisted(() => ({
  read: vi.fn(),
  publish: vi.fn(),
  build: vi.fn(),
  feed: vi.fn(),
  stage: vi.fn<(stage: string) => Promise<void>>(),
  write: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
  end: vi.fn(),
  health: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());
vi.mock("./showcase-diagnostics", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publicationStage: mock.stage,
  recordDiagnosticFailure: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  rename: mock.rename,
  writeFile: mock.write,
  unlink: mock.unlink,
}));
vi.mock("../apps/scanner/src/local-env", () => ({ loadLocalEnvironment: vi.fn() }));
vi.mock("../packages/db/src/client", () => ({
  createDatabase: () => ({
    client: Object.assign(mock.health, { end: mock.end }),
    db: { transaction: async (fn: (db: object) => Promise<unknown>) => fn({}) },
  }),
}));
vi.mock("./showcase-neon-reader", () => ({ readPublishedCatalog: mock.read }));
vi.mock("../apps/scanner/src/showcase-neon-publication", () => ({
  loadShowcasePublisherDatabaseUrl: () => Promise.resolve("synthetic"),
  publishShowcaseCatalogToNeon: mock.publish,
}));
vi.mock("../apps/scanner/src/showcase-publication", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadShowcasePublicationSource: () =>
    Promise.resolve({
      releases: [
        {
          appleMusicUrl: "https://music.apple.com/us/album/synthetic/123",
          appleProviderReleaseId: "123",
        },
      ],
    }),
  buildShowcasePublicCatalog: mock.build,
}));
vi.mock("../apps/scanner/src/showcase-editorial-policy", () => ({
  applyShowcaseEditorialPolicy: (catalog: unknown) => Promise.resolve(catalog),
}));
vi.mock("../apps/scanner/src/showcase-apple-feed", () => ({
  AppleMusicFeedClient: class {},
  createAppleMusicFeedDeveloperToken: () => "synthetic",
  loadAppleMusicFeedCredentials: () => ({}),
  fetchAppleMusicFeedArtwork: mock.feed,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "synthetic");
  mock.health.mockResolvedValue([{ latest: new Date(), active: 0 }]);
  mock.feed.mockResolvedValue({ artworkByAppleReleaseId: new Map() });
  mock.read.mockReset();
  mock.rename.mockReset();
});

describe("Showcase publication stages", () => {
  it("publishes changed content once and verifies readback before replacing local JSON", async () => {
    const updated = {
      ...generated,
      releases: generated.releases.map((r, i) =>
        i ? r : { ...r, title: "Synthetic changed release" },
      ),
    };
    mock.read.mockResolvedValueOnce(generated).mockResolvedValueOnce(updated);
    mock.build.mockReturnValue({ catalog: updated });
    const result = await publishShowcaseCatalog();
    expect(result.changed).toBe(true);
    expect(mock.publish).toHaveBeenCalledOnce();
    expect(mock.read).toHaveBeenCalledTimes(2);
    expect(mock.rename).toHaveBeenCalledOnce();
    expect(mock.stage.mock.calls.map(([stage]) => stage)).toContain("neon-readback");
  });
  it("does not write Neon or call Feed for unchanged content", async () => {
    mock.read.mockResolvedValue(generated);
    mock.build.mockReturnValue({ catalog: generated });
    expect((await publishShowcaseCatalog()).changed).toBe(false);
    expect(mock.publish).not.toHaveBeenCalled();
    expect(mock.feed).not.toHaveBeenCalled();
    expect(mock.read).toHaveBeenCalledOnce();
  });
  it("stops on readback failure without replacing the last local snapshot", async () => {
    const updated = {
      ...generated,
      releases: generated.releases.map((r, i) => (i ? r : { ...r, title: "Synthetic update" })),
    };
    mock.read
      .mockResolvedValueOnce(generated)
      .mockRejectedValueOnce(
        Object.assign(new Error("Synthetic connection"), { code: "ECONNRESET" }),
      );
    mock.build.mockReturnValue({ catalog: updated });
    await expect(publishShowcaseCatalog()).rejects.toThrow("Synthetic connection");
    expect(mock.stage).toHaveBeenLastCalledWith("neon-readback");
    expect(mock.write).not.toHaveBeenCalled();
  });
  it("defers an active scanner before Feed or publication", async () => {
    mock.read.mockResolvedValue(generated);
    mock.health.mockResolvedValue([{ latest: new Date(), active: 1 }]);
    await expect(publishShowcaseCatalog()).rejects.toThrow(/active/);
    expect(mock.stage).toHaveBeenLastCalledWith("scanner-readiness");
    expect(mock.publish).not.toHaveBeenCalled();
    expect(mock.feed).not.toHaveBeenCalled();
  });
  it("cleans up only its own temporary snapshot when replacement fails", async () => {
    mock.read.mockResolvedValue(generated);
    mock.build.mockReturnValue({ catalog: generated });
    mock.rename.mockRejectedValue(
      Object.assign(new Error("Synthetic locked file"), { code: "EPERM" }),
    );
    await expect(publishShowcaseCatalog()).rejects.toThrow("Synthetic locked file");
    expect(mock.unlink).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(new RegExp(`generated-public-catalog\\.json\\.${process.pid}\\.tmp$`)),
    );
    expect(mock.publish).not.toHaveBeenCalled();
  });
});
