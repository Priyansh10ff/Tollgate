/**
 * Checks that this machine is ready to run Tollgate:
 *   - Node.js version
 *   - .env file and required settings
 *   - PayPal sandbox credentials (and whether Payouts is enabled)
 *   - Claude API key (and which models it can use)
 *
 * Secrets are never printed.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ok = (msg: string) => console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`  \x1b[33m!\x1b[0m ${msg}`);
const fail = (msg: string) => console.log(`  \x1b[31m✘\x1b[0m ${msg}`);
const section = (title: string) => console.log(`\n\x1b[1m${title}\x1b[0m`);

let problems = 0;

// ── Node.js ────────────────────────────────────────────────────
section("Node.js");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 13)) {
  ok(`Node ${process.versions.node}`);
} else {
  fail(`Node ${process.versions.node} is too old. Install Node 22.13 or newer (LTS) from nodejs.org.`);
  problems++;
}

// ── .env ───────────────────────────────────────────────────────
section(".env file");
const envPath = resolve(process.cwd(), ".env");
if (!existsSync(envPath)) {
  fail('No .env file found. Copy ".env.example" to ".env" and fill it in.');
  process.exit(1);
}
process.loadEnvFile(envPath);
ok(".env found");

const env = (name: string) => (process.env[name] ?? "").trim();
const required = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_API_BASE", "HUB_URL", "HUB_ADMIN_TOKEN"];
for (const name of required) {
  if (env(name)) ok(`${name} is set`);
  else {
    fail(`${name} is empty`);
    problems++;
  }
}
if (!env("DEMO_SELLER_PAYPAL_EMAIL")) {
  warn("DEMO_SELLER_PAYPAL_EMAIL is empty. Set it to a sandbox account email so demo payouts work.");
}
if (env("HUB_ADMIN_TOKEN") === "change-me") {
  warn('HUB_ADMIN_TOKEN is still "change-me". Pick your own password before deploying.');
}

// ── PayPal ─────────────────────────────────────────────────────
section("PayPal sandbox");
if (env("PAYPAL_CLIENT_ID") && env("PAYPAL_CLIENT_SECRET")) {
  const base = env("PAYPAL_API_BASE") || "https://api-m.sandbox.paypal.com";
  if (!base.includes("sandbox")) warn("PAYPAL_API_BASE is not the sandbox URL. Use sandbox while building.");
  try {
    const auth = Buffer.from(`${env("PAYPAL_CLIENT_ID")}:${env("PAYPAL_CLIENT_SECRET")}`).toString("base64");
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) {
      fail(`PayPal rejected the credentials (HTTP ${res.status}). Re-copy the Client ID and Secret from the Sandbox tab.`);
      problems++;
    } else {
      const data = (await res.json()) as { scope?: string; app_id?: string };
      ok(`Credentials work (app ${data.app_id ?? "unknown"})`);
      const scope = data.scope ?? "";
      if (scope.includes("payments/payouts")) ok("Payouts is enabled");
      else {
        warn("Payouts does not look enabled. In the app settings, tick Features → Payouts and save.");
      }
    }
  } catch (err) {
    fail(`Could not reach PayPal: ${(err as Error).message}`);
    problems++;
  }
} else {
  warn("Skipped: PayPal keys not set");
}

// ── Claude ─────────────────────────────────────────────────────
section("Claude API");
if (env("ANTHROPIC_API_KEY")) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=50", {
      headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) {
      fail(`Claude rejected the key (HTTP ${res.status}). Create a new key at console.anthropic.com.`);
      problems++;
    } else {
      const data = (await res.json()) as { data: { id: string; display_name?: string }[] };
      const ids = data.data.map((m) => m.id);
      ok(`Key works (${ids.length} models available)`);
      const model = env("CLAUDE_MODEL");
      if (!model) {
        warn("CLAUDE_MODEL is empty. Pick one of these and put it in .env:");
        for (const m of data.data.slice(0, 8)) console.log(`      ${m.id}${m.display_name ? `  (${m.display_name})` : ""}`);
      } else if (ids.includes(model)) {
        ok(`CLAUDE_MODEL "${model}" is available`);
      } else {
        fail(`CLAUDE_MODEL "${model}" is not in your available models`);
        problems++;
      }
    }
  } catch (err) {
    fail(`Could not reach the Claude API: ${(err as Error).message}`);
    problems++;
  }
} else {
  warn("Skipped: ANTHROPIC_API_KEY not set (needed later for the demo agent)");
}

// ── Result ─────────────────────────────────────────────────────
console.log(problems === 0 ? "\n\x1b[32mAll good. Ready to build.\x1b[0m\n" : `\n\x1b[31m${problems} problem(s) to fix.\x1b[0m\n`);
process.exit(problems === 0 ? 0 : 1);
