/**
 * The Tollgate 402 protocol.
 *
 *  1. Agent requests a paid resource.
 *  2. Seller answers 402 Payment Required with a Quote (price, seller id, resource, nonce).
 *  3. Agent sends the Quote to its Tollgate hub. The hub enforces the owner's spending
 *     rules, charges the wallet and returns a Receipt signed with the hub's Ed25519 key.
 *  4. Agent repeats the request with the Receipt in the `Tollgate-Receipt` header.
 *  5. Seller verifies the Receipt offline with the hub's public key, checks it is for this
 *     seller, this resource and at least this price, that it hasn't expired and hasn't been
 *     used before, then serves the response.
 */

export const PROTOCOL_VERSION = 1;

/** Request header carrying a receipt. */
export const RECEIPT_HEADER = "Tollgate-Receipt";
/** Response header on a 402 with the price, for quick inspection. */
export const PRICE_HEADER = "Tollgate-Price";
/** Path where a hub publishes its receipt-signing public keys. */
export const WELL_KNOWN_PATH = "/.well-known/tollgate.json";

/** How long a receipt stays valid after it's issued. */
export const RECEIPT_TTL_SECONDS = 300;

export interface Quote {
  version: typeof PROTOCOL_VERSION;
  /** Hub the seller accepts payments through. */
  hub: string;
  /** Seller id registered on that hub. */
  seller: string;
  /** Price in USD as a decimal string, e.g. "0.03". Up to 6 decimals. */
  price: string;
  currency: "USD";
  /** What is being bought: "METHOD /path?query". */
  resource: string;
  /** Full URL of the resource, so the agent can check who it's paying. */
  url: string;
  description?: string;
  /** Random per-402 value. Paying the same quote twice only charges once. */
  nonce: string;
}

export interface PaymentRequiredBody {
  error: "payment_required";
  message: string;
  tollgate: Quote;
  /** Present when a receipt was sent but rejected. */
  receiptError?: { code: string; message: string };
}

/** Claims inside a receipt (a compact JWS signed with EdDSA / Ed25519). */
export interface ReceiptClaims {
  /** Issuer: the hub URL. */
  iss: string;
  /** Subject: the agent that paid. */
  sub: string;
  /** Audience: the seller that was paid. */
  aud: string;
  /** Receipt id. Sellers accept each id only once. */
  jti: string;
  /** Amount paid, in micros (1 USD = 1,000,000). */
  amt: number;
  /** Resource paid for: "METHOD /path?query". */
  res: string;
  /** Ledger transaction id. */
  txn: string;
  iat: number;
  exp: number;
}

export interface HubKeys {
  version: typeof PROTOCOL_VERSION;
  hub: string;
  keys: { kid: string; alg: "EdDSA"; jwk: JsonWebKey }[];
}

/** Canonical resource string for a request. */
export function resourceOf(method: string, pathWithQuery: string): string {
  return `${method.toUpperCase()} ${pathWithQuery}`;
}

/** Normalises a base URL for comparisons: lowercase origin, no trailing slash. */
export function normalizeBaseUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
}
