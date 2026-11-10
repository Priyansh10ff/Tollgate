import { createPrivateKey, type KeyObject, type JsonWebKey as NodeJwk } from "node:crypto";
import { generateSigningKey, keyId, PROTOCOL_VERSION, type HubKeys } from "@tollgate/protocol";
import type { DB } from "./db.ts";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
}

/**
 * The hub's Ed25519 receipt-signing key. Created on first start and kept in the database.
 * HUB_SIGNING_KEY (a private JWK as JSON) overrides it, so a redeployed hub keeps its identity.
 */
export function loadSigningKey(db: DB, fromEnv?: string): SigningKey {
  if (fromEnv) return fromPrivateJwk(JSON.parse(fromEnv));

  const row = db.prepare("SELECT value FROM settings WHERE key = 'signing_key'").get() as { value: string } | undefined;
  if (row) return fromPrivateJwk(JSON.parse(row.value));

  const key = generateSigningKey();
  db.prepare("INSERT INTO settings (key, value) VALUES ('signing_key', ?)").run(JSON.stringify(key.privateKey.export({ format: "jwk" })));
  return key;
}

function fromPrivateJwk(jwk: JsonWebKey): SigningKey {
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return { kid: keyId(publicJwk), privateKey: createPrivateKey({ key: jwk as NodeJwk, format: "jwk" }), publicJwk };
}

export function publicKeys(hubUrl: string, key: SigningKey): HubKeys {
  return { version: PROTOCOL_VERSION, hub: hubUrl, keys: [{ kid: key.kid, alg: "EdDSA", jwk: key.publicJwk }] };
}
