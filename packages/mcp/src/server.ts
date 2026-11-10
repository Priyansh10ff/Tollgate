/**
 * Tollgate MCP server over stdio.
 *
 * Needs TOLLGATE_HUB_URL and TOLLGATE_AGENT_KEY. If they aren't set, falls back to
 * the repo's .env (HUB_URL) and the demo agent in data/demo.json.
 * Only MCP messages may go to stdout, so all logging goes to stderr.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTollgateMcpServer } from "./index.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const hubUrl = process.env.TOLLGATE_HUB_URL || process.env.HUB_URL || "http://localhost:4000";
const demoFile = join(ROOT, "data", "demo.json");
const agentKey =
  process.env.TOLLGATE_AGENT_KEY || (existsSync(demoFile) ? (JSON.parse(readFileSync(demoFile, "utf8")).agentKey as string) : "");

if (!agentKey) {
  console.error("Tollgate MCP: set TOLLGATE_AGENT_KEY (or run `npm run try setup` for the demo agent).");
  process.exit(1);
}

const server = createTollgateMcpServer({ hubUrl, agentKey });
await server.connect(new StdioServerTransport());
console.error(`Tollgate MCP server running (hub ${hubUrl})`);
