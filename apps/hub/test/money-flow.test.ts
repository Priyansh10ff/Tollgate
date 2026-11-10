import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "./helpers.ts";

test("admin API requires the admin token", async () => {
  const s = await testServer();
  try {
    const res = await s.api("GET", "/api/overview", undefined, "wrong");
    assert.equal(res.status, 401);
  } finally {
    await s.close();
  }
});

test("top-up through PayPal credits the wallet exactly once", async () => {
  const s = await testServer();
  try {
    const { body: created } = await s.api("POST", "/api/agents", { name: "Research Agent" });
    assert.match(created.apiKey, /^tg_agent_/);
    const agentId = created.agent.id;

    const start = await s.api("POST", `/api/agents/${agentId}/topups`, { amountUsd: "10.00" });
    assert.equal(start.status, 201);
    const orderId = start.body.topup.paypalOrderId;

    // Return before approval: nothing is credited.
    const early = await fetch(`${s.base}/paypal/return?token=${orderId}`);
    assert.notEqual(early.status, 200);

    s.paypal.approve(orderId);
    const done = await fetch(`${s.base}/paypal/return?token=${orderId}`);
    assert.equal(done.status, 200);
    assert.match(await done.text(), /\$10\.00/);

    // Refreshing the return page must not credit again.
    await fetch(`${s.base}/paypal/return?token=${orderId}`);
    const { body: overview } = await s.api("GET", "/api/overview");
    assert.equal(overview.agents[0].balance, 10_000_000);
    assert.equal(overview.audit.ok, true);
    assert.equal(overview.audit.totals.toppedUp, 10_000_000);
  } finally {
    await s.close();
  }
});

test("top-up amount limits are enforced", async () => {
  const s = await testServer();
  try {
    const { body } = await s.api("POST", "/api/agents", { name: "A" });
    for (const amountUsd of ["0.50", "1000", "1.005", "abc"]) {
      const res = await s.api("POST", `/api/agents/${body.agent.id}/topups`, { amountUsd });
      assert.equal(res.status, 400, amountUsd);
    }
  } finally {
    await s.close();
  }
});

test("a capture that doesn't match the top-up is not credited", async () => {
  const s = await testServer();
  try {
    const { body } = await s.api("POST", "/api/agents", { name: "A" });
    const start = await s.api("POST", `/api/agents/${body.agent.id}/topups`, { amountUsd: "5" });
    const order = s.paypal.approve(start.body.topup.paypalOrderId);
    order.input.amountCents = 100; // PayPal reports a different amount than we asked for
    const res = await fetch(`${s.base}/paypal/return?token=${order.id}`);
    assert.equal(res.status, 409);
    const { body: overview } = await s.api("GET", "/api/overview");
    assert.equal(overview.agents[0].balance, 0);
  } finally {
    await s.close();
  }
});

test("seller payout moves earnings out through PayPal", async () => {
  const s = await testServer();
  try {
    const agent = (await s.api("POST", "/api/agents", { name: "A" })).body.agent;
    const seller = (await s.api("POST", "/api/sellers", { name: "Atlas Data", paypalEmail: "seller@example.com" })).body.seller;
    const start = await s.api("POST", `/api/agents/${agent.id}/topups`, { amountUsd: "20" });
    s.paypal.approve(start.body.topup.paypalOrderId);
    await fetch(`${s.base}/paypal/return?token=${start.body.topup.paypalOrderId}`);

    // 500 requests at $0.03: seller earns 500 × $0.0297 = $14.85
    await s.api("POST", "/api/simulate/charges", { agentId: agent.id, sellerId: seller.id, priceUsd: "0.03", count: 500 });

    const payout = await s.api("POST", `/api/sellers/${seller.id}/payouts`, {});
    assert.equal(payout.status, 201);
    assert.equal(payout.body.payout.amount, 14_850_000);
    assert.equal(payout.body.payout.status, "processing");

    const refreshed = await s.api("POST", `/api/payouts/${payout.body.payout.id}/refresh`);
    assert.equal(refreshed.body.payout.status, "paid");

    const { body: overview } = await s.api("GET", "/api/overview");
    assert.equal(overview.sellers[0].balance, 0);
    assert.equal(overview.audit.ok, true);
    assert.equal(overview.audit.totals.paidOut, 14_850_000);
    assert.equal(overview.audit.totals.fees, 150_000);
    assert.equal(overview.audit.totals.heldInWallets, 5_000_000);
  } finally {
    await s.close();
  }
});

test("a failed payout returns the money to the seller", async () => {
  const s = await testServer();
  try {
    const agent = (await s.api("POST", "/api/agents", { name: "A" })).body.agent;
    const seller = (await s.api("POST", "/api/sellers", { name: "S", paypalEmail: "will-fail@example.com" })).body.seller;
    const start = await s.api("POST", `/api/agents/${agent.id}/topups`, { amountUsd: "10" });
    s.paypal.approve(start.body.topup.paypalOrderId);
    await fetch(`${s.base}/paypal/return?token=${start.body.topup.paypalOrderId}`);
    await s.api("POST", "/api/simulate/charges", { agentId: agent.id, sellerId: seller.id, priceUsd: "2.00", count: 1 });

    const payout = (await s.api("POST", `/api/sellers/${seller.id}/payouts`, {})).body.payout;
    assert.equal(payout.amount, 1_980_000);
    const after = (await s.api("POST", `/api/payouts/${payout.id}/refresh`)).body.payout;
    assert.equal(after.status, "failed");

    const { body: overview } = await s.api("GET", "/api/overview");
    assert.equal(overview.sellers[0].balance, 1_980_000);
    assert.equal(overview.audit.totals.paidOut, 0);
    assert.equal(overview.audit.ok, true);

    // Refreshing again doesn't reverse twice.
    await s.api("POST", `/api/payouts/${payout.id}/refresh`);
    assert.equal((await s.api("GET", "/api/overview")).body.sellers[0].balance, 1_980_000);
  } finally {
    await s.close();
  }
});

test("payouts below the minimum are refused", async () => {
  const s = await testServer();
  try {
    const seller = (await s.api("POST", "/api/sellers", { name: "S", paypalEmail: "s@example.com" })).body.seller;
    const res = await s.api("POST", `/api/sellers/${seller.id}/payouts`, {});
    assert.equal(res.status, 400);
  } finally {
    await s.close();
  }
});
