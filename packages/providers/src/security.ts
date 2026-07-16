import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface EncryptedValue {
  ciphertext: string;
  nonce: string;
}

export interface OAuthChallenge {
  codeChallenge: string;
  codeVerifier: string;
  state: string;
  stateHash: string;
}

function encryptionKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return decoded;
}

export function encryptSecret(plaintext: string, applicationKey: string): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(applicationKey), nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, tag]).toString("base64url"),
    nonce: nonce.toString("base64url"),
  };
}

export function decryptSecret(value: EncryptedValue, applicationKey: string): string {
  const packed = Buffer.from(value.ciphertext, "base64url");
  if (packed.length < 17) throw new Error("Encrypted secret is malformed");
  const encrypted = packed.subarray(0, -16);
  const tag = packed.subarray(-16);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(applicationKey),
    Buffer.from(value.nonce, "base64url"),
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

export function createOAuthChallenge(): OAuthChallenge {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(64).toString("base64url");
  return {
    codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"),
    codeVerifier,
    state,
    stateHash: hashOAuthState(state),
  };
}

export function signFlowCookie(flowId: string, applicationKey: string): string {
  const signature = createHmac("sha256", encryptionKey(applicationKey))
    .update(flowId)
    .digest("base64url");
  return `${flowId}.${signature}`;
}

export function verifyFlowCookie(value: string, applicationKey: string): string | undefined {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const flowId = value.slice(0, separator);
  const actual = Buffer.from(value.slice(separator + 1), "base64url");
  const expected = createHmac("sha256", encryptionKey(applicationKey)).update(flowId).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  return flowId;
}

export function createApplicationEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}
