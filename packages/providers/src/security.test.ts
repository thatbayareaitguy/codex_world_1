import { describe, expect, it } from "vitest";
import {
  createApplicationEncryptionKey,
  createOAuthChallenge,
  decryptSecret,
  encryptSecret,
  hashOAuthState,
  signFlowCookie,
  verifyFlowCookie,
} from "./security";

describe("provider secret security", () => {
  it("encrypts with unique nonces and rejects tampering", () => {
    const key = createApplicationEncryptionKey();
    const first = encryptSecret("refresh-token", key);
    const second = encryptSecret("refresh-token", key);

    expect(first).not.toEqual(second);
    expect(decryptSecret(first, key)).toBe("refresh-token");
    expect(() => decryptSecret({ ...first, ciphertext: `${first.ciphertext}x` }, key)).toThrow();
  });

  it("creates PKCE state and signs the server flow cookie", () => {
    const key = createApplicationEncryptionKey();
    const challenge = createOAuthChallenge();
    const cookie = signFlowCookie("flow-id", key);

    expect(challenge.stateHash).toBe(hashOAuthState(challenge.state));
    expect(challenge.codeChallenge).not.toBe(challenge.codeVerifier);
    expect(verifyFlowCookie(cookie, key)).toBe("flow-id");
    expect(verifyFlowCookie(`${cookie}x`, key)).toBeUndefined();
  });
});
