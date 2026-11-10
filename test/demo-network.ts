import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDemoApis } from "@tollgate/demo-api";
import { loadConfig } from "../apps/hub/src/config.ts";
import { openDb, SYSTEM_ACCOUNTS } from "../apps/hub/src/db.ts";
import { createHub } from "../apps/hub/src/hub.ts";
import { createApp } from "../apps/hub/src/app.ts";
import { PayPalMock } from "../apps/hub/src/paypal/index.ts";

export const ADMIN = "test-admin";

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, () => resolve((server.address() as AddressInfo).port)));

/**
 * The full demo, in-process: hub, Atlas Data (reached as "localhost") and QuickLeads
 * (reached as "127.0.0.1"), plus the demo agent with the same rules as `npm run try setup`.
 */
export async function demoNetwork() {
  const hubServer = http.createServer();
  const hubUrl = `http://localhost:${await listen(hubServer)}`;
  const hub = createHub(loadConfig({ dbPath: ":memory:", adminToken: ADMIN, hubUrl, feeBps: 100 }), {
    db: openDb(":memory:"),
    paypal: new PayPalMock(hubUrl),
  });
  hubServer.on("request", createApp(hub));

  const atlasSeller = hub.participants.createSeller("Atlas Data", "atlas@example.com").seller;
  const leadsSeller = hub.participants.createSeller("QuickLeads").seller;
  const { atlas, quickLeads } = createDemoApis({ hubUrl, atlasSellerId: atlasSeller.id, quickLeadsSellerId: leadsSeller.id });
  const atlasServer = http.createServer(atlas);
  const leadsServer = http.createServer(quickLeads);
  const atlasUrl = `http://localhost:${await listen(atlasServer)}`;
  const leadsUrl = `http://127.0.0.1:${await listen(leadsServer)}`;

  const { agent, apiKey } = hub.participants.createAgent("Research Agent", {
    dailyLimit: 2_000_000,
    maxPerRequest: 1_000_000,
    approvalAbove: 250_000,
    allowedHosts: ["localhost"],
  });
  hub.ledger.post({
    type: "topup",
    legs: [
      { accountId: SYSTEM_ACCOUNTS.paypalIn, amount: -10_000_000 },
      { accountId: agent.accountId, amount: 10_000_000 },
    ],
  });

  const admin = (method: string, path: string) =>
    fetch(`${hubUrl}${path}`, { method, headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());

  /** Approves the next payment that asks for approval (stands in for the owner). */
  const autoApprove = async (decision: "approve" | "deny" = "approve") => {
    for (let i = 0; i < 200; i++) {
      const { approvals } = await admin("GET", "/api/approvals?status=pending");
      if (approvals.length) return admin("POST", `/api/approvals/${approvals[0].id}/${decision}`);
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("No approval request arrived");
  };

  const servers = [hubServer, atlasServer, leadsServer];
  return {
    hub,
    hubUrl,
    atlasUrl,
    leadsUrl,
    agent,
    agentKey: apiKey,
    atlasSeller,
    leadsSeller,
    admin,
    autoApprove,
    walletBalance: () => hub.ledger.balance(agent.accountId),
    close: async () => {
      for (const s of servers) s.closeAllConnections();
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    },
  };
}
