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
  /** Whether anyone can create an account on the website. */
  allowSignups: boolean;
  /** Hosted demo: the research agent runs on the hub for signed-in users. */
  demo: {
    anthropicApiKey: string;
    claudeModel: string;
    /** Claude-powered runs allowed per UTC day across all users. After that, runs use the replay model. */
    claudeRunsPerDay: number;
    /** PayPal email for the demo Atlas Data seller's payouts (a sandbox Personal account). */
    sellerPaypalEmail: string;
    /** Optional sandbox buyer login shown in the demo, so visitors can finish a PayPal sandbox checkout. */
    buyerEmail: string;
    buyerPassword: string;
  };
  /** Where the website/dashboard is served: the hub itself after `npm run build`, else the Vite dev server. */
  webUrl: string;
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
  const hubUrl = (env("HUB_URL") || env("RENDER_EXTERNAL_URL") || `http://localhost:${port}`).replace(/\/+$/, "");
  const built = existsSync(join(REPO_ROOT, "apps", "web", "dist", "index.html"));

  return {
    port,
    hubUrl,
    adminToken: env("HUB_ADMIN_TOKEN", "change-me"),
    dbPath: env("DB_PATH", join(REPO_ROOT, "data", "tollgate.db")),
    paypal: { mode, clientId, clientSecret, apiBase },
    feeBps: Number(env("TOLLGATE_FEE_BPS", "100")),
    minPayoutMicros: Math.round(Number(env("MIN_PAYOUT_USD", "1.00")) * 1_000_000),
    signingKeyJwk: env("HUB_SIGNING_KEY") || undefined,
    allowSignups: env("ALLOW_SIGNUPS", "true") !== "false",
    demo: {
      anthropicApiKey: env("ANTHROPIC_API_KEY"),
      claudeModel: env("CLAUDE_MODEL"),
      claudeRunsPerDay: Number(env("DEMO_CLAUDE_RUNS_PER_DAY", "30")),
      sellerPaypalEmail: env("DEMO_SELLER_PAYPAL_EMAIL"),
      buyerEmail: env("DEMO_PAYPAL_BUYER_EMAIL"),
      buyerPassword: env("DEMO_PAYPAL_BUYER_PASSWORD"),
    },
    webUrl: env("WEB_URL", built ? hubUrl : "http://localhost:5173").replace(/\/+$/, ""),
    ...overrides,
  };
}
