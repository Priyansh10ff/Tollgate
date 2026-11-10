/**
 * Runs the demo research agent in the terminal.
 *
 *   npm run agent
 *   npm run agent -- "Is Lumen Health a good investment?"
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TollgateClient, type TollgateEvent } from "@tollgate/client";
import { microsToUsd } from "@tollgate/protocol";
import { runResearchAgent, type AgentStep } from "./agent.ts";
import { claudeModel } from "./claude.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const DEFAULT_TASK =
  "Should we consider acquiring Northwind Robotics? Check their profile, financials and recent news, " +
  "read the full analyst report, and get direct contacts for their executives so we can reach out.";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function fail(message: string): never {
  console.error(`\n${c.red("✘")} ${message}\n`);
  process.exit(1);
}

const apiKey = process.env.ANTHROPIC_API_KEY || fail("ANTHROPIC_API_KEY is not set in .env");
const model = process.env.CLAUDE_MODEL || fail("CLAUDE_MODEL is not set in .env (run npm run check-setup to see available models)");
const hubUrl = process.env.HUB_URL || "http://localhost:4000";
const demoFile = join(ROOT, "data", "demo.json");
const agentKey =
  process.env.TOLLGATE_AGENT_KEY ||
  (existsSync(demoFile) ? (JSON.parse(readFileSync(demoFile, "utf8")).agentKey as string) : "") ||
  fail("No agent key. Start the hub and run: npm run try setup");

const sources = [process.env.DEMO_API_URL || "http://localhost:4100", process.env.DEMO_LEADS_URL || "http://127.0.0.1:4200"];
const task = process.argv.slice(2).join(" ").trim() || DEFAULT_TASK;

const onPayment = (e: TollgateEvent) => {
  const what = e.quote.description ?? e.quote.resource;
  if (e.type === "paid") console.log(`   ${c.green("$")} paid ${c.bold(`$${e.quote.price}`)} for ${what}  ${c.dim(`wallet $${microsToUsd(e.balance)}`)}`);
  if (e.type === "approval_pending") console.log(`   ${c.yellow("…")} ${c.yellow(`$${e.quote.price} for ${what} needs your approval`)} ${c.dim("(approve in the dashboard or: npm run try approve)")}`);
  if (e.type === "approval_granted") console.log(`   ${c.green("✔")} owner approved`);
  if (e.type === "declined") console.log(`   ${c.red("✘")} ${c.red(`blocked: ${e.message}`)}`);
};

const onStep = (step: AgentStep) => {
  if (step.kind === "thought") console.log(`\n${c.cyan("◆")} ${step.text}`);
  if (step.kind === "tool_call") {
    const arg = step.name === "fetch_data" ? String(step.input.url) : "";
    console.log(`${c.dim("→")} ${step.name} ${c.dim(arg)}`);
  }
};

const wallet = new TollgateClient({ hubUrl, agentKey, onEvent: onPayment, approvalTimeoutMs: 5 * 60_000 });

const before = await wallet.wallet().catch((err) => fail(`Can't reach the hub at ${hubUrl}: ${(err as Error).message}. Is "npm run dev" running?`));
console.log(`\n${c.bold("Research agent")}  ${c.dim(`model ${model} · wallet $${microsToUsd(before.balance)}`)}`);
console.log(`${c.bold("Task:")} ${task}`);

const { answer } = await runResearchAgent({ task, model: claudeModel({ apiKey, model }), wallet, sources, onStep }).catch((err) =>
  fail(`Agent stopped: ${(err as Error).message}`),
);

const after = await wallet.wallet();
console.log(`\n${c.bold("─── Brief ───────────────────────────────────────────")}\n\n${answer}\n`);
console.log(c.dim(`Wallet: $${microsToUsd(before.balance)} → $${microsToUsd(after.balance)}  (spent $${microsToUsd(before.balance - after.balance)})\n`));
