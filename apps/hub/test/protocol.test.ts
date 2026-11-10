import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { tollgate } from "@tollgate/express";
import { TollgateClient, TollgatePaymentError, type TollgateEvent } from "@tollgate/client";
import { RECEIPT_HEADER, type PaymentRequiredBody } from "@tollgate/protocol";
import { loadConfig } from "../src/config.ts";
import { openDb, SYSTEM_ACCOUNTS } from "../src/db.ts";
import { createHub } from "../src/hub.ts";
import { createApp } from "../src/app.ts";
import { PayPalMock } from "../src/paypal/index.ts";
import type { AgentPolicy } from "../src/services/participants.ts";
import { ADMIN } from "./helpers.ts";

const listen = (server: http.Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** A hub, a seller API protected by tollgate(), and an agent with a funded wallet. */
async function network(opts: { policy?: Partial<AgentPolicy>; walletUsd?: number; sellerHub?: string } = {}) {
  const hubServer = http.createServer();
  const hubUrl = await listen(hubServer);
  const hub = createHub(loadConfig({ dbPath: ":memory:", adminToken: ADMIN, hubUrl, feeBps: 100 }), {
    db: openDb(":memory:"),
    paypal: new PayPalMock(hubUrl),
  });
  hubServer.on("request", createApp(hub));

  const { seller } = hub.participants.createSeller("Atlas Data", "seller@example.com");
  const gate = (price: string, description: string) => tollgate({ hubUrl: opts.sellerHub ?? hubUrl, sellerId: seller.id, price, description });

  const api = express();
  api.get("/v1/companies/:name", gate("0.03", "Company profile"), (req, res) => {
    res.json({ company: req.params.name, employees: 420, paidBy: req.tollgate?.sub });
  });
  api.get("/v1/reports/:name", gate("0.50", "Full market report"), (req, res) => {
    res.json({ report: `Deep dive on ${req.params.name}` });
  });
  api.get("/v1/free", tollgate({ hubUrl, sellerId: seller.id, price: () => null }), (_req, res) => res.json({ free: true }));
  const sellerServer = http.createServer(api);
  const sellerUrl = await listen(sellerServer);

  const { agent, apiKey } = hub.participants.createAgent("Research Agent", {
    maxPerRequest: 1_000_000,
    approvalAbove: 250_000,
    dailyLimit: 5_000_000,
    ...opts.policy,
  });
  const fund = Math.round((opts.walletUsd ?? 10) * 1_000_000);
  hub.ledger.post({
    type: "topup",
    legs: [
      { accountId: SYSTEM_ACCOUNTS.paypalIn, amount: -fund },
      { accountId: agent.accountId, amount: fund },
    ],
  });

  const events: TollgateEvent[] = [];
  const client = new TollgateClient({ hubUrl, agentKey: apiKey, pollIntervalMs: 20, approvalTimeoutMs: 3000, onEvent: (e) => events.push(e) });

  const admin = (method: string, path: string) =>
    fetch(`${hubUrl}${path}`, { method, headers: { Authorization: `Bearer ${ADMIN}` } }).then((r) => r.json());

  return {
    hub,
    hubUrl,
    sellerUrl,
    seller,
    agent,
    client,
    events,
    admin,
    walletBalance: () => hub.ledger.balance(agent.accountId),
    sellerBalance: () => hub.ledger.balance(seller.accountId),
    close: async () => {
      hubServer.closeAllConnections();
      sellerServer.closeAllConnections();
      await Promise.all([new Promise((r) => hubServer.close(r)), new Promise((r) => sellerServer.close(r))]);
    },
  };
}

const quoteFrom = async (url: string) => {
  const res = await fetch(url);
  assert.equal(res.status, 402);
  return ((await res.json()) as PaymentRequiredBody).tollgate;
};

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (err: unknown) => err instanceof TollgatePaymentError && err.code === code);

test("without a receipt, the seller answers 402 with a quote", async () => {
  const n = await network();
  try {
    const res = await fetch(`${n.sellerUrl}/v1/companies/acme`);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get("tollgate-price"), "0.03 USD");
    const body = (await res.json()) as PaymentRequiredBody;
    assert.equal(body.tollgate.seller, n.seller.id);
    assert.equal(body.tollgate.price, "0.03");
    assert.equal(body.tollgate.resource, "GET /v1/companies/acme");
    assert.equal(body.tollgate.hub, n.hubUrl);
    assert.equal((await fetch(`${n.sellerUrl}/v1/free`)).status, 200);
  } finally {
    await n.close();
  }
});

test("the agent pays automatically and gets the data", async () => {
  const n = await network();
  try {
    const res = await n.client.fetch(`${n.sellerUrl}/v1/companies/acme`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.company, "acme");
    assert.equal(data.paidBy, n.agent.id);
    assert.equal(n.walletBalance(), 9_970_000);
    assert.equal(n.sellerBalance(), 29_700); // $0.03 minus 1% fee
    assert.deepEqual(n.events.map((e) => e.type), ["payment_required", "paid"]);
    assert.equal(n.hub.ledger.audit().ok, true);
  } finally {
    await n.close();
  }
});

test("a receipt can only be used once", async () => {
  const n = await network();
  try {
    const receipt = await n.client.pay(await quoteFrom(`${n.sellerUrl}/v1/companies/acme`));
    const send = () => fetch(`${n.sellerUrl}/v1/companies/acme`, { headers: { [RECEIPT_HEADER]: receipt } });
    assert.equal((await send()).status, 200);
    const replay = await send();
    assert.equal(replay.status, 402);
    assert.equal(((await replay.json()) as PaymentRequiredBody).receiptError?.code, "replayed");
  } finally {
    await n.close();
  }
});

test("a receipt for one resource can't unlock another", async () => {
  const n = await network();
  try {
    const receipt = await n.client.pay(await quoteFrom(`${n.sellerUrl}/v1/companies/cheap`));
    const res = await fetch(`${n.sellerUrl}/v1/companies/other`, { headers: { [RECEIPT_HEADER]: receipt } });
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as PaymentRequiredBody).receiptError?.code, "wrong_resource");
  } finally {
    await n.close();
  }
});

test("a tampered receipt is rejected", async () => {
  const n = await network();
  try {
    const receipt = await n.client.pay(await quoteFrom(`${n.sellerUrl}/v1/companies/acme`));
    const [h, p, s] = receipt.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.res = "GET /v1/reports/acme"; // try to upgrade a $0.03 receipt to the $0.50 report
    claims.amt = 500_000;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    const res = await fetch(`${n.sellerUrl}/v1/reports/acme`, { headers: { [RECEIPT_HEADER]: forged } });
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as PaymentRequiredBody).receiptError?.code, "bad_signature");
  } finally {
    await n.close();
  }
});

test("paying the same quote twice only charges once", async () => {
  const n = await network();
  try {
    const quote = await quoteFrom(`${n.sellerUrl}/v1/companies/acme`);
    const first = await n.client.pay(quote);
    const second = await n.client.pay(quote);
    assert.equal(first, second);
    assert.equal(n.walletBalance(), 9_970_000);
  } finally {
    await n.close();
  }
});

test("spending rules: per-request limit, allowed hosts, daily limit, balance", async () => {
  let n = await network({ policy: { maxPerRequest: 100_000 } });
  try {
    await rejects(n.client.fetch(`${n.sellerUrl}/v1/reports/acme`), "policy_max_per_request");
    assert.equal(n.walletBalance(), 10_000_000);
    assert.equal(n.events.at(-1)?.type, "declined");
  } finally {
    await n.close();
  }

  n = await network({ policy: { allowedHosts: ["api.trusted.com"] } });
  try {
    await rejects(n.client.fetch(`${n.sellerUrl}/v1/companies/acme`), "policy_host_not_allowed");
  } finally {
    await n.close();
  }

  n = await network({ policy: { dailyLimit: 50_000 } });
  try {
    assert.equal((await n.client.fetch(`${n.sellerUrl}/v1/companies/a`)).status, 200);
    await rejects(n.client.fetch(`${n.sellerUrl}/v1/companies/b`), "policy_daily_limit");
  } finally {
    await n.close();
  }

  n = await network({ walletUsd: 0.02 });
  try {
    await rejects(n.client.fetch(`${n.sellerUrl}/v1/companies/a`), "insufficient_funds");
  } finally {
    await n.close();
  }
});

test("parallel requests can't overspend the daily limit", async () => {
  const n = await network({ policy: { dailyLimit: 300_000 } }); // room for exactly 10 × $0.03
  try {
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => n.client.fetch(`${n.sellerUrl}/v1/companies/c${i}`)));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === 200).length;
    assert.equal(ok, 10);
    assert.equal(n.walletBalance(), 10_000_000 - 300_000);
  } finally {
    await n.close();
  }
});

test("expensive requests wait for a human: approved", async () => {
  const n = await network(); // approval above $0.25
  try {
    const pending = n.client.fetch(`${n.sellerUrl}/v1/reports/acme`);
    let approvals: { id: string; amount: number }[] = [];
    for (let i = 0; i < 50 && approvals.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      approvals = (await n.admin("GET", "/api/approvals?status=pending")).approvals;
    }
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].amount, 500_000);
    assert.equal(n.walletBalance(), 10_000_000); // nothing charged while waiting
    await n.admin("POST", `/api/approvals/${approvals[0].id}/approve`);

    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(n.walletBalance(), 9_500_000);
    assert.deepEqual(n.events.map((e) => e.type), ["payment_required", "approval_pending", "approval_granted", "paid"]);
    assert.equal((await n.admin("GET", "/api/approvals")).approvals[0].status, "used");
  } finally {
    await n.close();
  }
});

test("expensive requests wait for a human: denied", async () => {
  const n = await network();
  try {
    const pending = n.client.fetch(`${n.sellerUrl}/v1/reports/acme`);
    let approvals: { id: string }[] = [];
    for (let i = 0; i < 50 && approvals.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      approvals = (await n.admin("GET", "/api/approvals?status=pending")).approvals;
    }
    await n.admin("POST", `/api/approvals/${approvals[0].id}/deny`);
    await rejects(pending, "approval_denied");
    assert.equal(n.walletBalance(), 10_000_000);
  } finally {
    await n.close();
  }
});

test("the agent refuses to pay through a hub that isn't its own", async () => {
  const n = await network({ sellerHub: "http://some-other-hub.test" });
  try {
    await rejects(n.client.fetch(`${n.sellerUrl}/v1/companies/acme`), "unknown_hub");
    assert.equal(n.walletBalance(), 10_000_000);
  } finally {
    await n.close();
  }
});

test("agent API needs a valid agent key and exposes the wallet", async () => {
  const n = await network();
  try {
    const bad = await fetch(`${n.hubUrl}/v1/wallet`, { headers: { Authorization: "Bearer tg_agent_nope" } });
    assert.equal(bad.status, 401);
    await n.client.fetch(`${n.sellerUrl}/v1/companies/acme`);
    const wallet = await n.client.wallet();
    assert.equal(wallet.balance, 9_970_000);
    assert.equal(wallet.spentToday, 30_000);
  } finally {
    await n.close();
  }
});
