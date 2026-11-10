import { createHash, createPublicKey, generateKeyPairSync, sign, verify, KeyObject, type JsonWebKey as NodeJwk } from "node:crypto";
import type { ReceiptClaims } from "./types.ts";

/**
 * Receipts are compact JWS tokens (header.payload.signature) signed with Ed25519 ("EdDSA").
 * Standard JWT libraries can read them; this module has no dependencies.
 */

export type ReceiptErrorCode =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "wrong_issuer"
  | "wrong_seller"
  | "wrong_resource"
  | "underpaid"
  | "replayed";

export class ReceiptError extends Error {
  constructor(
    public code: ReceiptErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const fromB64url = (text: string) => Buffer.from(text, "base64url");

export function generateSigningKey(): { kid: string; privateKey: KeyObject; publicJwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  return { kid: keyId(publicJwk), privateKey, publicJwk };
}

/** Stable key id derived from the public key. */
export function keyId(publicJwk: JsonWebKey): string {
  return createHash("sha256").update(String(publicJwk.x)).digest("base64url").slice(0, 16);
}

export function signReceipt(claims: ReceiptClaims, privateKey: KeyObject, kid: string): string {
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** Reads a receipt without checking the signature. Never trust the result on its own. */
export function decodeReceipt(token: string): { header: { alg: string; kid?: string }; claims: ReceiptClaims } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new ReceiptError("malformed", "Receipt is not a compact JWS");
  try {
    return { header: JSON.parse(fromB64url(parts[0]).toString()), claims: JSON.parse(fromB64url(parts[1]).toString()) };
  } catch {
    throw new ReceiptError("malformed", "Receipt is not valid JSON");
  }
}

export interface VerifyOptions {
  /** Public keys by kid. */
  keys: Map<string, JsonWebKey | KeyObject>;
  issuer?: string;
  seller?: string;
  resource?: string;
  /** Minimum amount, in micros. */
  minAmount?: number;
  /** Seconds since epoch; defaults to now. */
  now?: number;
  /** Allowed clock difference in seconds. */
  leeway?: number;
}

/** Verifies signature and claims. Throws ReceiptError with a specific code on failure. */
export function verifyReceipt(token: string, options: VerifyOptions): ReceiptClaims {
  const { header, claims } = decodeReceipt(token);
  if (header.alg !== "EdDSA") throw new ReceiptError("malformed", `Unsupported algorithm ${header.alg}`);
  const key = header.kid ? options.keys.get(header.kid) : undefined;
  if (!key) throw new ReceiptError("unknown_key", "Receipt was signed with an unknown key");

  const publicKey = key instanceof KeyObject ? key : createPublicKey({ key: key as NodeJwk, format: "jwk" });
  const [h, p, s] = token.split(".");
  if (!verify(null, Buffer.from(`${h}.${p}`), publicKey, fromB64url(s))) {
    throw new ReceiptError("bad_signature", "Receipt signature is invalid");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const leeway = options.leeway ?? 30;
  if (typeof claims.exp !== "number" || now > claims.exp + leeway) throw new ReceiptError("expired", "Receipt has expired");
  if (typeof claims.iat !== "number" || claims.iat > now + leeway) throw new ReceiptError("not_yet_valid", "Receipt is from the future");
  if (options.issuer && claims.iss !== options.issuer) throw new ReceiptError("wrong_issuer", "Receipt is from a different hub");
  if (options.seller && claims.aud !== options.seller) throw new ReceiptError("wrong_seller", "Receipt is for a different seller");
  if (options.resource && claims.res !== options.resource) {
    throw new ReceiptError("wrong_resource", `Receipt is for "${claims.res}", not "${options.resource}"`);
  }
  if (options.minAmount !== undefined && !(claims.amt >= options.minAmount)) {
    throw new ReceiptError("underpaid", "Receipt amount is below the price");
  }
  return claims;
}
