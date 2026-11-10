import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export type PayPalMode = "sandbox" | "live" | "mock";

export interface Config {
  port: number;
  hubUrl: string;
  adminToken: string;
  dbPath: string;
  paypal: {
    mode: PayPalMode;
    clientId: string;
    clientSecret: string;
    apiBase: string;
  };
  /** Platform fee on each charge, in basis points (100 = 1%). */
  feeBps: number;
  /** Smallest amount a seller can withdraw, in micros. */
  minPayoutMicros: number;
  /** Optional private JWK (JSON) for signing receipts. Otherwise one is generated and stored in the DB. */
  signingKeyJwk?: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const envFile = join(REPO_ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const env = (name: string, fallback = "") => (process.env[name] ?? "").trim() || fallback;

  const clientId = env("PAYPAL_CLIENT_ID");
  const clientSecret = env("PAYPAL_CLIENT_SECRET");
  const apiBase = env("PAYPAL_API_BASE", "https://api-m.sandbox.paypal.com");
  const explicitMode = env("PAYPAL_MODE") as PayPalMode | "";
  const mode: PayPalMode =
    explicitMode || (!clientId || !clientSecret ? "mock" : apiBase.includes("sandbox") ? "sandbox" : "live");

  const port = Number(env("PORT") || env("HUB_PORT", "4000"));

  return {
    port,
    hubUrl: env("HUB_URL", `http://localhost:${port}`).replace(/\/+$/, ""),
    adminToken: env("HUB_ADMIN_TOKEN", "change-me"),
    dbPath: env("DB_PATH", join(REPO_ROOT, "data", "tollgate.db")),
    paypal: { mode, clientId, clientSecret, apiBase },
    feeBps: Number(env("TOLLGATE_FEE_BPS", "100")),
    minPayoutMicros: 1_000_000,
    signingKeyJwk: env("HUB_SIGNING_KEY") || undefined,
    ...overrides,
  };
}
