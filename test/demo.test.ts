import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TollgateClient, type TollgateEvent } from "@tollgate/client";
import { createTollgateMcpServer } from "@tollgate/mcp";
import { runResearchAgent, type AgentStep, type ContentBlock, type Message, type ModelCall } from "@tollgate/demo-agent";
import { demoNetwork } from "./demo-network.ts";

/** Stands in for Claude: plays back a fixed sequence of tool calls, then answers. */
function scriptedModel(urls: string[], seen: Message[][]): ModelCall {
  let step = 0;
  return async ({ messages }) => {
    seen.push(structuredClone(messages));
    if (step < urls.length) {
      const url = urls[step];
      step++;
      const content: ContentBlock[] = [
        { type: "text", text: `Fetching ${url}` },
        { type: "tool_use", id: `tu_${step}`, name: "fetch_data", input: { url } },
      ];
      return { content, stop_reason: "tool_use" };
    }
    return { content: [{ type: "text", text: "Recommendation: proceed with diligence." }], stop_reason: "end_turn" };
  };
}

const lastToolResult = (messages: Message[]) => {
  const last = messages.at(-1)!.content as { content: string; is_error: boolean }[];
  return last[0];
};

test("demo: the research agent buys data, waits for approval, and gets blocked from an unvetted site", async () => {
  const n = await demoNetwork();
  try {
    const urls = [
      `${n.atlasUrl}/v1/catalog`, // free
      `${n.atlasUrl}/v1/companies/NVDA`, // $0.02
      `${n.atlasUrl}/v1/companies/NVDA/financials`, // $0.05
      `${n.atlasUrl}/v1/news?q=NVIDIA`, // $0.01
      `${n.atlasUrl}/v1/reports/NVDA`, // $0.50 → owner approval
      `${n.leadsUrl}/v1/leads?company=NVDA`, // $0.40 on a site the agent may not pay
    ];
    const seen: Message[][] = [];
    const payments: TollgateEvent[] = [];
    const steps: AgentStep[] = [];
    const wallet = new TollgateClient({ hubUrl: n.hubUrl, agentKey: n.agentKey, pollIntervalMs: 20, onEvent: (e) => payments.push(e) });

    const approval = n.autoApprove("approve");
    const { answer } = await runResearchAgent({
      task: "Should we invest in NVIDIA?",
      model: scriptedModel(urls, seen),
      wallet,
      sources: [n.atlasUrl, n.leadsUrl],
      onStep: (s) => steps.push(s),
    });
    await approval;

    assert.equal(answer, "Recommendation: proceed with diligence.");
    // Each tool result the model saw, in order:
    assert.match(lastToolResult(seen[1]).content, /HTTP 200[\s\S]*Atlas Data/); // catalog
    assert.match(lastToolResult(seen[2]).content, /Santa Clara/); // profile
    assert.match(lastToolResult(seen[3]).content, /revenueM/); // financials
    assert.match(lastToolResult(seen[4]).content, /GPU architecture/); // news
    assert.match(lastToolResult(seen[5]).content, /"revenueGrowthPct":114.2/); // report, after approval
    const blocked = lastToolResult(seen[6]);
    assert.equal(blocked.is_error, true);
    assert.match(blocked.content, /Payment declined \(policy_host_not_allowed\)/);

    assert.deepEqual(
      payments.map((p) => `${p.type}${"quote" in p ? ` ${p.quote.price}` : ""}`),
      [
        "payment_required 0.02", "paid 0.02",
        "payment_required 0.05", "paid 0.05",
        "payment_required 0.01", "paid 0.01",
        "payment_required 0.50", "approval_pending 0.50", "approval_granted 0.50", "paid 0.50",
        "payment_required 0.40", "declined 0.40",
      ],
    );
    assert.equal(n.walletBalance(), 10_000_000 - 580_000);
    assert.equal(n.hub.ledger.balance(n.leadsSeller.accountId), 0);
    assert.equal(n.hub.ledger.audit().ok, true);
    assert.ok(steps.some((s) => s.kind === "tool_result" && !s.ok));
  } finally {
    await n.close();
  }
});

test("demo: the agent's request is denied when the owner says no", async () => {
  const n = await demoNetwork();
  try {
    const seen: Message[][] = [];
    const wallet = new TollgateClient({ hubUrl: n.hubUrl, agentKey: n.agentKey, pollIntervalMs: 20 });
    const denial = n.autoApprove("deny");
    await runResearchAgent({
      task: "Get the report",
      model: scriptedModel([`${n.atlasUrl}/v1/reports/NVDA`], seen),
      wallet,
      sources: [n.atlasUrl],
    });
    await denial;
    assert.match(lastToolResult(seen[1]).content, /Payment declined \(approval_denied\)/);
    assert.equal(n.walletBalance(), 10_000_000);
  } finally {
    await n.close();
  }
});

test("MCP: any assistant can use the wallet through the Tollgate MCP server", async () => {
  const n = await demoNetwork();
  try {
    const server = createTollgateMcpServer({ hubUrl: n.hubUrl, agentKey: n.agentKey, approvalTimeoutMs: 3000 });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test-assistant", version: "1.0.0" });
    await client.connect(clientSide);

    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["tollgate_fetch", "tollgate_wallet"]);

    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0].text;

    const paid = await client.callTool({ name: "tollgate_fetch", arguments: { url: `${n.atlasUrl}/v1/companies/NVDA` } });
    assert.equal(paid.isError, false);
    assert.match(text(paid), /^HTTP 200\nPaid \$0\.02/);
    assert.match(text(paid), /NVIDIA CORP/);

    const free = await client.callTool({ name: "tollgate_fetch", arguments: { url: `${n.atlasUrl}/v1/catalog` } });
    assert.match(text(free), /No payment needed/);

    const blocked = await client.callTool({ name: "tollgate_fetch", arguments: { url: `${n.leadsUrl}/v1/leads?company=NVDA` } });
    assert.equal(blocked.isError, true);
    assert.match(text(blocked), /policy_host_not_allowed/);

    const wallet = await client.callTool({ name: "tollgate_wallet", arguments: {} });
    assert.match(text(wallet), /Balance: \$9\.98/);
    assert.match(text(wallet), /Allowed sites: localhost/);

    await client.close();
  } finally {
    await n.close();
  }
});
