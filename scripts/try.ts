/**
 * Command-line tool for trying the money flow against a running hub.
 *
 *   npm run try setup              create a demo agent and seller
 *   npm run try topup 10           top up the agent's wallet with $10 via PayPal
 *   npm run try charge 0.03 100    simulate 100 paid requests at $0.03
 *   npm run try payout             pay the seller's earnings out via PayPal
 *   npm run try status             balances, top-ups, payouts and ledger audit
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { microsToUsd } from "@tollgate/protocol";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const HUB = (process.env.HUB_URL || "http://localhost:4000").replace(/\/+$/, "");
const TOKEN = process.env.HUB_ADMIN_TOKEN || "change-me";
const DEMO_FILE = join(ROOT, "data", "demo.json");

interface Demo {
  agentId: string;
  agentKey: string;
  sellerId: string;
  sellerKey: string;
  quickLeadsSellerId: string;
}

async function api(method: string, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${HUB}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Can't reach the hub at ${HUB}. Start it first with: npm run hub`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error?.code ?? res.status}: ${data.error?.message ?? "request failed"}${data.error?.details ? `\n${JSON.stringify(data.error.details, null, 2)}` : ""}`);
  return data;
}

function loadDemo(): Demo {
  if (!existsSync(DEMO_FILE)) throw new Error('No demo agent yet. Run: npm run try setup');
  return JSON.parse(readFileSync(DEMO_FILE, "utf8"));
}

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    // Opening the browser is a convenience; the URL is printed anyway.
  }
}

const usd = (micros: number) => `$${microsToUsd(micros)}`;

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async setup(args) {
    // npm keeps "--force" for itself and exposes it as npm_config_force.
    const force = args.includes("--force") || process.env.npm_config_force === "true";
    if (existsSync(DEMO_FILE) && !force) {
      console.log("Demo agent and seller already exist (use --force to create new ones).");
      return commands.status([]);
    }
    const email = args.find((a) => a.includes("@")) || process.env.DEMO_SELLER_PAYPAL_EMAIL || undefined;
    const atlasHost = new URL(process.env.DEMO_API_URL || "http://localhost:4100").hostname;
    const agent = await api("POST", "/api/agents", {
      name: "Research Agent",
      // The demo agent may only pay Atlas Data, and must ask before spending more than $0.25 at once.
      policy: { dailyLimitUsd: "2.00", maxPerRequestUsd: "1.00", approvalAboveUsd: "0.25", allowedHosts: [atlasHost] },
    });
    const seller = await api("POST", "/api/sellers", { name: "Atlas Data", paypalEmail: email });
    const quickLeads = await api("POST", "/api/sellers", { name: "QuickLeads" });
    const demo: Demo = {
      agentId: agent.agent.id,
      agentKey: agent.apiKey,
      sellerId: seller.seller.id,
      sellerKey: seller.apiKey,
      quickLeadsSellerId: quickLeads.seller.id,
    };
    mkdirSync(join(ROOT, "data"), { recursive: true });
    writeFileSync(DEMO_FILE, JSON.stringify(demo, null, 2));
    console.log(`Created agent  ${demo.agentId} (Research Agent)`);
    console.log(`Created seller ${demo.sellerId} (Atlas Data)${email ? `, payouts to ${email}` : ""}`);
    console.log(`Created seller ${demo.quickLeadsSellerId} (QuickLeads, not on the agent's allowed list)`);
    console.log(`Agent rules: $2.00/day, max $1.00 per request, approval above $0.25, only pays ${atlasHost}`);
    if (!email) console.log("Tip: set DEMO_SELLER_PAYPAL_EMAIL in .env (a sandbox account email) so payouts work.");
    console.log(`API keys saved to data/demo.json (git-ignored).`);
  },

  async topup([amount = "10"]) {
    const demo = loadDemo();
    const { approveUrl, topup } = await api("POST", `/api/agents/${demo.agentId}/topups`, { amountUsd: amount });
    console.log(`Top-up ${topup.id} for ${usd(topup.amount)} created.`);
    console.log(`\nApprove the payment in your browser (log in with your sandbox PERSONAL account):\n\n  ${approveUrl}\n`);
    console.log("After paying, you'll land on a 'Wallet topped up' page. Then run: npm run try status");
    openInBrowser(approveUrl);
  },

  async charge([price = "0.03", count = "10"]) {
    const demo = loadDemo();
    const res = await api("POST", "/api/simulate/charges", {
      agentId: demo.agentId,
      sellerId: demo.sellerId,
      priceUsd: price,
      count: Number(count),
    });
    console.log(`Agent paid $${price} × ${res.charges}. Wallet balance now ${usd(res.agentBalance)}.`);
  },

  async payout([amount]) {
    const demo = loadDemo();
    const { payout } = await api("POST", `/api/sellers/${demo.sellerId}/payouts`, amount ? { amountUsd: amount } : {});
    console.log(`Payout ${payout.id} for ${usd(payout.amount)} sent to PayPal (batch ${payout.paypalBatchId}).`);
    console.log("PayPal processes payouts in the background. Run 'npm run try status' in ~30 seconds.");
  },

  async approve() {
    await decide("approve");
  },

  async deny() {
    await decide("deny");
  },

  async status() {
    const overview = await api("GET", "/api/overview");
    const { payouts } = await api("GET", "/api/payouts");
    for (const p of payouts.filter((p: { status: string }) => p.status === "processing")) {
      await api("POST", `/api/payouts/${p.id}/refresh`).catch(() => {});
    }
    const { payouts: fresh } = await api("GET", "/api/payouts");
    const { topups } = await api("GET", "/api/topups");

    console.log(`\nHub ${HUB}  ·  PayPal: ${overview.paypalMode}  ·  fee ${overview.feeBps / 100}%\n`);
    console.log("Agents");
    for (const a of overview.agents) console.log(`  ${a.name.padEnd(18)} ${usd(a.balance).padStart(12)}   ${a.id}`);
    console.log("Sellers");
    for (const s of overview.sellers) console.log(`  ${s.name.padEnd(18)} ${usd(s.balance).padStart(12)}   ${s.paypalEmail ?? "(no PayPal email)"}`);
    if (topups.length) {
      console.log("Recent top-ups");
      for (const t of topups.slice(0, 5)) console.log(`  ${usd(t.amount).padStart(10)}  ${t.status.padEnd(10)} ${t.paypalOrderId ?? ""} ${t.error ?? ""}`);
    }
    if (fresh.length) {
      console.log("Recent payouts");
      for (const p of fresh.slice(0, 5)) console.log(`  ${usd(p.amount).padStart(10)}  ${p.status.padEnd(10)} ${p.paypalItemStatus ?? ""} ${p.error ?? ""}`);
    }
    const a = overview.audit;
    console.log(`\nLedger audit: ${a.ok ? "OK, every cent accounted for" : "PROBLEM"}  (${a.txnCount} txns)`);
    console.log(`  topped up ${usd(a.totals.toppedUp)} = in wallets ${usd(a.totals.heldInWallets)} + owed to sellers ${usd(a.totals.owedToSellers)} + paid out ${usd(a.totals.paidOut)} + fees ${usd(a.totals.fees)}\n`);
  },
};

async function decide(action: "approve" | "deny") {
  const { approvals } = await api("GET", "/api/approvals?status=pending");
  if (!approvals.length) return void console.log("No payments are waiting for approval.");
  const oldest = approvals.at(-1);
  await api("POST", `/api/approvals/${oldest.id}/${action}`);
  console.log(`${action === "approve" ? "Approved" : "Denied"} ${usd(oldest.amount)} for ${oldest.description ?? oldest.url}`);
}

const [name = "status", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.log("Usage: npm run try <setup|topup|charge|payout|status|approve|deny> [args]");
  process.exit(1);
}
command(args).catch((err) => {
  console.error(`\n${(err as Error).message}\n`);
  process.exit(1);
});
