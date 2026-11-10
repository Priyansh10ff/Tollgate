import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSigningKey, signReceipt, verifyReceipt, decodeReceipt, ReceiptError, type ReceiptClaims } from "../src/index.ts";

const key = generateSigningKey();
const keys = new Map([[key.kid, key.publicJwk]]);
const now = 1_800_000_000;
const claims: ReceiptClaims = {
  iss: "http://hub.test",
  sub: "agt_1",
  aud: "slr_1",
  jti: "rcpt_1",
  amt: 30_000,
  res: "GET /v1/data?q=1",
  txn: "txn_1",
  iat: now,
  exp: now + 300,
};

const expectCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (err: unknown) => err instanceof ReceiptError && err.code === code);

test("a valid receipt verifies", () => {
  const token = signReceipt(claims, key.privateKey, key.kid);
  const result = verifyReceipt(token, { keys, issuer: "http://hub.test", seller: "slr_1", resource: "GET /v1/data?q=1", minAmount: 30_000, now });
  assert.deepEqual(result, claims);
  assert.equal(decodeReceipt(token).header.alg, "EdDSA");
});

test("tampering with the amount breaks the signature", () => {
  const token = signReceipt(claims, key.privateKey, key.kid);
  const [h, , s] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims, amt: 999_999_999 })).toString("base64url");
  expectCode(() => verifyReceipt(`${h}.${forged}.${s}`, { keys, now }), "bad_signature");
});

test("a receipt signed by another key is rejected", () => {
  const other = generateSigningKey();
  const token = signReceipt(claims, other.privateKey, key.kid); // claims our kid
  expectCode(() => verifyReceipt(token, { keys, now }), "bad_signature");
  expectCode(() => verifyReceipt(signReceipt(claims, other.privateKey, other.kid), { keys, now }), "unknown_key");
});

test("claim checks", () => {
  const token = signReceipt(claims, key.privateKey, key.kid);
  expectCode(() => verifyReceipt(token, { keys, now: now + 1000 }), "expired");
  expectCode(() => verifyReceipt(token, { keys, now, seller: "slr_2" }), "wrong_seller");
  expectCode(() => verifyReceipt(token, { keys, now, resource: "GET /v1/other" }), "wrong_resource");
  expectCode(() => verifyReceipt(token, { keys, now, minAmount: 30_001 }), "underpaid");
  expectCode(() => verifyReceipt(token, { keys, now, issuer: "http://evil.test" }), "wrong_issuer");
  expectCode(() => verifyReceipt("not.a-token", { keys, now }), "malformed");
});
