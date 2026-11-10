/**
 * Prints a new Ed25519 private key (JWK JSON) for HUB_SIGNING_KEY.
 * Set it on your deployed hub so receipts keep verifying after a redeploy.
 *
 *   npm run signing-key
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ed25519");
console.log(JSON.stringify(privateKey.export({ format: "jwk" })));
