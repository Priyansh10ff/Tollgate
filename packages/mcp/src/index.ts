import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TollgateClient, TollgatePaymentError, type TollgateEvent } from "@tollgate/client";
import { microsToUsd } from "@tollgate/protocol";

export interface TollgateMcpOptions {
  hubUrl: string;
  agentKey: string;
  fetch?: typeof fetch;
  /** How long a tool call waits for the owner to approve a payment. Default 2 minutes. */
  approvalTimeoutMs?: number;
}

const MAX_BODY_CHARS = 20_000;

/**
 * MCP server exposing a Tollgate wallet as tools, so any MCP client
 * (Claude Desktop, Claude Code, ...) can call paid APIs.
 */
export function createTollgateMcpServer(options: TollgateMcpOptions): McpServer {
  const server = new McpServer({ name: "tollgate", version: "0.1.0" });

  server.registerTool(
    "tollgate_fetch",
    {
      title: "Fetch (pays automatically)",
      description:
        "Fetch a URL. If the server asks for payment (HTTP 402 with a Tollgate quote), it is paid from your Tollgate wallet " +
        "within the spending rules your owner set, then the request is retried. Larger payments may wait for the owner's approval. " +
        "Returns the response status, body and what was paid.",
      inputSchema: {
        url: z.url().describe("Full http(s) URL"),
        method: z.enum(["GET", "POST"]).default("GET"),
        body: z.string().optional().describe("Request body for POST (sent as-is)"),
        contentType: z.string().optional().describe("Content-Type for the body, e.g. application/json"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, method, body, contentType }) => {
      const payments: TollgateEvent[] = [];
      const client = new TollgateClient({
        hubUrl: options.hubUrl,
        agentKey: options.agentKey,
        fetch: options.fetch,
        approvalTimeoutMs: options.approvalTimeoutMs ?? 120_000,
        onEvent: (e) => payments.push(e),
      });
      try {
        const res = await client.fetch(url, {
          method,
          body: method === "POST" ? body : undefined,
          headers: contentType ? { "Content-Type": contentType } : undefined,
        });
        const text = await res.text();
        const paid = payments.find((e) => e.type === "paid");
        const header = [
          `HTTP ${res.status}`,
          paid && paid.type === "paid"
            ? `Paid $${paid.quote.price} to ${new URL(paid.quote.url).host}${paid.quote.description ? ` for ${paid.quote.description}` : ""} (wallet balance $${microsToUsd(paid.balance)})`
            : "No payment needed",
          payments.some((e) => e.type === "approval_granted") ? "Owner approved this payment" : undefined,
        ]
          .filter(Boolean)
          .join("\n");
        const clipped = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n… [truncated]` : text;
        return { content: [{ type: "text", text: `${header}\n\n${clipped}` }], isError: !res.ok };
      } catch (err) {
        if (err instanceof TollgatePaymentError) {
          return {
            content: [{ type: "text", text: `Payment declined (${err.code}): ${err.message}\nDon't retry this request.` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: `Request failed: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "tollgate_wallet",
    {
      title: "Wallet",
      description: "Show the Tollgate wallet balance, today's spending and the spending rules.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const client = new TollgateClient({ hubUrl: options.hubUrl, agentKey: options.agentKey, fetch: options.fetch });
      try {
        const w = await client.wallet();
        const lines = [
          `Agent: ${w.name}`,
          `Balance: $${microsToUsd(w.balance)}`,
          `Spent today: $${microsToUsd(w.spentToday)} of $${microsToUsd(w.policy.dailyLimit)} daily limit`,
          `Max per request: $${microsToUsd(w.policy.maxPerRequest)}`,
          `Needs owner approval above: $${microsToUsd(w.policy.approvalAbove)}`,
          `Allowed sites: ${w.policy.allowedHosts.length ? w.policy.allowedHosts.join(", ") : "any"}`,
        ];
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Could not read wallet: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}
