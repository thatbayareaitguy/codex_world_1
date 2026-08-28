import { describe, expect, it } from "vitest";

import { isLocalGenreAdminMutation, isLocalGenreAdminRequest } from "./local-admin-access";

const enabled = { SHOWCASE_GENRE_ADMIN_ENABLED: "true" };

describe("local genre administration access", () => {
  it("allows the explicitly enabled loopback site", () => {
    const headers = new Headers({ host: "127.0.0.1:3200" });
    expect(isLocalGenreAdminRequest(headers, enabled)).toBe(true);
  });

  it("stays unavailable when disabled or served from another host", () => {
    expect(isLocalGenreAdminRequest(new Headers({ host: "127.0.0.1:3200" }), {})).toBe(false);
    expect(isLocalGenreAdminRequest(new Headers({ host: "showcase.example.com" }), enabled)).toBe(
      false,
    );
    expect(isLocalGenreAdminRequest(new Headers({ host: "127.0.0.1.example.com" }), enabled)).toBe(
      false,
    );
  });

  it("requires a same-origin loopback request for writes", () => {
    expect(
      isLocalGenreAdminMutation(
        new Headers({ host: "127.0.0.1:3200", origin: "http://127.0.0.1:3200" }),
        enabled,
      ),
    ).toBe(true);
    expect(
      isLocalGenreAdminMutation(
        new Headers({ host: "127.0.0.1:3200", origin: "https://other.example" }),
        enabled,
      ),
    ).toBe(false);
    expect(isLocalGenreAdminMutation(new Headers({ host: "127.0.0.1:3200" }), enabled)).toBe(false);
  });
});
