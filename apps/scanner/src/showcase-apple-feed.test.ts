import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppleMusicFeedClient,
  createAppleMusicFeedDeveloperToken,
  selectAppleMusicFeedArtwork,
} from "./showcase-apple-feed";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Showcase Apple Music Feed publication client", () => {
  it("creates a short-lived ES256 developer token without exposing the private key", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "showcase-feed-token-"));
    temporaryDirectories.push(directory);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privateKeyPath = resolve(directory, "AuthKey_ABCDEFGHIJ.p8");
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), "utf8");

    const token = createAppleMusicFeedDeveloperToken(
      { keyId: "ABCDEFGHIJ", privateKeyPath, teamId: "KLMNOPQRST" },
      new Date("2026-08-29T12:00:00Z"),
    );
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid: "ABCDEFGHIJ",
    });
    const claims = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(claims).toMatchObject({ iss: "KLMNOPQRST" });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(3600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        { dsaEncoding: "ieee-p1363", key: publicKey },
        Buffer.from(encodedSignature!, "base64url"),
      ),
    ).toBe(true);
  });

  it("reads the latest album export and accepts only the Apple Feed CDN", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/v1/feed/album/latest") {
        return Promise.resolve(Response.json({ data: [{ id: "export-1" }] }));
      }
      return Promise.resolve(
        Response.json({
          data: [{ id: "part-1" }],
          resources: {
            parts: {
              "part-1": {
                attributes: { exportLocation: "https://media-feed.cdn-apple.com/album-part" },
                id: "part-1",
              },
            },
          },
        }),
      );
    });
    const client = new AppleMusicFeedClient({
      developerToken: "synthetic-token",
      fetchImpl: fetchMock,
      minimumRequestIntervalMs: 0,
    });

    await expect(client.listLatestAlbumParts()).resolves.toEqual([
      { exportLocation: "https://media-feed.cdn-apple.com/album-part", id: "part-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an export part hosted outside Apple's Feed CDN", async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      return Promise.resolve(
        url.pathname === "/v1/feed/album/latest"
          ? Response.json({ data: [{ id: "export-1" }] })
          : Response.json({
              data: [{ id: "part-1" }],
              resources: {
                parts: {
                  "part-1": {
                    attributes: { exportLocation: "https://example.com/private-part" },
                    id: "part-1",
                  },
                },
              },
            }),
      );
    });
    const client = new AppleMusicFeedClient({
      developerToken: "synthetic-token",
      fetchImpl: fetchMock,
      minimumRequestIntervalMs: 0,
    });

    await expect(client.listLatestAlbumParts()).rejects.toThrow("untrusted part URL");
  });

  it("selects the largest default Apple artwork and rejects other hosts", () => {
    expect(
      selectAppleMusicFeedArtwork({
        default: [
          { height: 600, url: "https://is1-ssl.mzstatic.com/image/thumb/small.jpg", width: 600 },
          {
            height: 3000,
            url: "https://is5-ssl.mzstatic.com/image/thumb/original.jpg",
            width: 3000,
          },
          { height: 4000, url: "https://example.com/not-apple.jpg", width: 4000 },
        ],
      }),
    ).toEqual({
      height: 3000,
      source: "apple_music",
      url: "https://is5-ssl.mzstatic.com/image/thumb/original.jpg",
      width: 3000,
    });
    expect(
      selectAppleMusicFeedArtwork({
        default: [{ height: 600, url: "https://i.scdn.co/image/spotify", width: 600 }],
      }),
    ).toBeUndefined();
  });
});
