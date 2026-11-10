import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "./helpers.ts";

async function signup(s: Awaited<ReturnType<typeof testServer>>, email: string) {
  const res = await s.api("POST", "/api/auth/signup", { email, password: "correct horse battery" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.match(res.body.token, /^tg_sess_/);
  return res.body.token as string;
}

test("sign up, log in, log out", async () => {
  const s = await testServer();
  try {
    const token = await signup(s, "Ana@Example.com");
    const me = await s.api("GET", "/api/auth/me", undefined, token);
    assert.deepEqual([me.body.kind, me.body.user.email], ["user", "ana@example.com"]);

    assert.equal((await s.api("POST", "/api/auth/signup", { email: "ana@example.com", password: "another password" })).status, 409);
    assert.equal((await s.api("POST", "/api/auth/signup", { email: "short@example.com", password: "short" })).status, 400);
    assert.equal((await s.api("POST", "/api/auth/login", { email: "ana@example.com", password: "wrong password" })).status, 401);
    assert.equal((await s.api("POST", "/api/auth/login", { email: "nobody@example.com", password: "whatever123" })).status, 401);

    const login = await s.api("POST", "/api/auth/login", { email: "ANA@example.com", password: "correct horse battery" });
    assert.equal(login.status, 200);

    await s.api("POST", "/api/auth/logout", undefined, login.body.token);
    assert.equal((await s.api("GET", "/api/overview", undefined, login.body.token)).status, 401);
    // The other session still works.
    assert.equal((await s.api("GET", "/api/overview", undefined, token)).status, 200);
  } finally {
    await s.close();
  }
});

test("users only see and change their own agents and sellers", async () => {
  const s = await testServer();
  try {
    const ana = await signup(s, "ana@example.com");
    const ben = await signup(s, "ben@example.com");

    const { body: anaAgent } = await s.api("POST", "/api/agents", { name: "Ana's agent" }, ana);
    const { body: anaSeller } = await s.api("POST", "/api/sellers", { name: "Ana's API", paypalEmail: "ana@example.com" }, ana);
    const { body: benSeller } = await s.api("POST", "/api/sellers", { name: "Ben's API" }, ben);
    await s.api("POST", "/api/agents", { name: "Admin agent" }); // admin-owned

    const anaView = (await s.api("GET", "/api/overview", undefined, ana)).body;
    assert.deepEqual(anaView.agents.map((a: { name: string }) => a.name), ["Ana's agent"]);
    assert.deepEqual(anaView.sellers.map((x: { name: string }) => x.name), ["Ana's API"]);
    assert.equal(anaView.me.email, "ana@example.com");
    assert.equal(anaView.audit.totals, undefined, "users don't see platform totals");

    const benView = (await s.api("GET", "/api/overview", undefined, ben)).body;
    assert.equal(benView.agents.length, 0);
    assert.deepEqual(benView.sellers.map((x: { name: string }) => x.name), ["Ben's API"]);

    // The admin sees everyone.
    const adminView = (await s.api("GET", "/api/overview")).body;
    assert.equal(adminView.agents.length, 2);
    assert.equal(adminView.sellers.length, 2);

    // Ben can't touch Ana's agent or seller.
    const id = anaAgent.agent.id;
    assert.equal((await s.api("PATCH", `/api/agents/${id}/policy`, { dailyLimitUsd: "100" }, ben)).status, 404);
    assert.equal((await s.api("POST", `/api/agents/${id}/topups`, { amountUsd: "5" }, ben)).status, 404);
    assert.equal((await s.api("POST", `/api/agents/${id}/key`, undefined, ben)).status, 404);
    assert.equal((await s.api("POST", `/api/sellers/${anaSeller.seller.id}/payouts`, {}, ben)).status, 404);
    assert.equal((await s.api("PATCH", `/api/sellers/${anaSeller.seller.id}`, { paypalEmail: "ben@example.com" }, ben)).status, 404);
    assert.equal((await s.api("GET", `/api/ledger/txns?accountId=${anaAgent.agent.accountId}`, undefined, ben)).status, 404);

    // Admin-only endpoints.
    assert.equal((await s.api("GET", "/api/ledger/audit", undefined, ana)).status, 403);
    const sim = { agentId: id, sellerId: benSeller.seller.id, priceUsd: "0.01" };
    assert.equal((await s.api("POST", "/api/simulate/charges", sim, ana)).status, 403);

    // Ana can manage her own agent and rotate its key.
    assert.equal((await s.api("PATCH", `/api/agents/${id}/policy`, { dailyLimitUsd: "3" }, ana)).status, 200);
    const rotated = await s.api("POST", `/api/agents/${id}/key`, undefined, ana);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.apiKey, anaAgent.apiKey);
    const wallet = await s.api("GET", "/v1/wallet", undefined, anaAgent.apiKey);
    assert.equal(wallet.status, 401, "old key stops working");
    assert.equal((await s.api("GET", "/v1/wallet", undefined, rotated.body.apiKey)).status, 200);
  } finally {
    await s.close();
  }
});

test("each side of a payment sees it, nobody else does", async () => {
  const s = await testServer();
  try {
    const ana = await signup(s, "ana@example.com");
    const ben = await signup(s, "ben@example.com");
    const cara = await signup(s, "cara@example.com");
    const { body: agent } = await s.api("POST", "/api/agents", { name: "Ana's agent" }, ana);
    const { body: seller } = await s.api("POST", "/api/sellers", { name: "Ben's API" }, ben);

    // Fund Ana's wallet through (simulated) PayPal, then charge it.
    const start = await s.api("POST", `/api/agents/${agent.agent.id}/topups`, { amountUsd: "5" }, ana);
    s.paypal.approve(start.body.topup.paypalOrderId);
    await fetch(`${s.base}/paypal/return?token=${start.body.topup.paypalOrderId}`);
    await s.api("POST", "/api/simulate/charges", { agentId: agent.agent.id, sellerId: seller.seller.id, priceUsd: "0.03", count: 2 });

    const anaTxns = await s.api("GET", `/api/ledger/txns?accountId=${agent.agent.accountId}`, undefined, ana);
    assert.equal(anaTxns.body.txns.length, 3);
    const benTxns = await s.api("GET", `/api/ledger/txns?accountId=${seller.seller.accountId}`, undefined, ben);
    assert.equal(benTxns.body.txns.length, 2);
    assert.equal((await s.api("GET", "/api/topups", undefined, ben)).body.topups.length, 0);
    assert.equal((await s.api("GET", "/api/topups", undefined, ana)).body.topups.length, 1);

    const events = async (token: string) => {
      const ctrl = new AbortController();
      const res = await fetch(`${s.base}/api/events?token=${token}`, { signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = "";
      const deadline = Date.now() + 300;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
        if (chunk && !chunk.done) text += new TextDecoder().decode(chunk.value);
      }
      ctrl.abort();
      return text.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    };
    assert.deepEqual(await events(ana), ["topup.created", "topup.completed", "charge.completed", "charge.completed"]);
    assert.deepEqual(await events(ben), ["charge.completed", "charge.completed"]);
    assert.deepEqual(await events(cara), []);
  } finally {
    await s.close();
  }
});
