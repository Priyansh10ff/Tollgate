import { test } from "node:test";
import assert from "node:assert/strict";
import { testServer } from "./helpers.ts";

/** Waits for an event of this type to show up in the hub's event history. */
async function waitFor(s: Awaited<ReturnType<typeof testServer>>, type: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = s.hub.events.history().find((e) => e.type === type);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`No ${type} event`);
}

test("hosted demo: a signed-up user runs the research agent end to end", async () => {
  const s = await testServer();
  try {
    const { body: auth } = await s.api("POST", "/api/auth/signup", { email: "judge@example.com", password: "password123" });
    const token = auth.token;

    const before = await s.api("GET", "/api/demo", undefined, token);
    assert.equal(before.body.ready, false);
    assert.equal(before.body.mode, "replay", "no Claude key in tests");
    assert.equal((await s.api("POST", "/api/demo/run", {}, token)).status, 409, "must set up first");

    const setup = await s.api("POST", "/api/demo/setup", undefined, token);
    assert.equal(setup.status, 201);
    const again = await s.api("POST", "/api/demo/setup", undefined, token);
    assert.equal(again.body.agentId, setup.body.agentId, "setup is idempotent");

    const overview = (await s.api("GET", "/api/overview", undefined, token)).body;
    assert.deepEqual(overview.agents.map((a: { name: string }) => a.name), ["Research Agent"]);
    assert.deepEqual(overview.sellers.map((x: { name: string }) => x.name), ["Atlas Data", "QuickLeads"]);
    const atlas = overview.sellers[0];

    // Fund the wallet through (simulated) PayPal.
    const topup = await s.api("POST", `/api/agents/${setup.body.agentId}/topups`, { amountUsd: "5" }, token);
    s.paypal.approve(topup.body.topup.paypalOrderId);
    await fetch(`${s.base}/paypal/return?token=${topup.body.topup.paypalOrderId}`);

    const run = await s.api("POST", "/api/demo/run", { task: "Should we invest in NVIDIA?" }, token);
    assert.equal(run.status, 202);
    assert.equal(run.body.mode, "replay");
    assert.equal((await s.api("POST", "/api/demo/run", {}, token)).status, 409, "one run at a time");

    // The $0.50 report waits for the owner. Another user can't approve it.
    await waitFor(s, "approval.requested");
    const { body: other } = await s.api("POST", "/api/auth/signup", { email: "other@example.com", password: "password123" });
    const pending = (await s.api("GET", "/api/approvals?status=pending", undefined, token)).body.approvals;
    assert.equal(pending.length, 1);
    assert.equal((await s.api("POST", `/api/approvals/${pending[0].id}/approve`, undefined, other.token)).status, 404);
    assert.equal((await s.api("POST", `/api/approvals/${pending[0].id}/approve`, undefined, token)).status, 200);

    const finished = await waitFor(s, "agent.finished");
    assert.match(String(finished.data.answer), /NVIDIA/);

    const declined = s.hub.events.history().find((e) => e.type === "payment.declined");
    assert.equal(declined?.data.code, "policy_host_not_allowed");
    assert.match(String(declined?.data.url), /^https:\/\/quickleads\.demo\//);

    const after = (await s.api("GET", "/api/overview", undefined, token)).body;
    assert.equal(after.agents[0].balance, 5_000_000 - 580_000, "spent $0.58");
    assert.equal(after.sellers.find((x: { id: string }) => x.id === atlas.id).balance, 574_200, "Atlas earned $0.58 minus 1%");
    assert.equal(after.audit.ok, true);
    assert.equal((await s.api("GET", "/api/demo", undefined, token)).body.running, false);
  } finally {
    await s.close();
  }
});

test("hosted demo agent can't reach anything but the demo sellers", async () => {
  const s = await testServer();
  try {
    const { body: auth } = await s.api("POST", "/api/auth/signup", { email: "judge@example.com", password: "password123" });
    await s.api("POST", "/api/demo/setup", undefined, auth.token);
    // A model that tries to make the hub fetch an internal address.
    s.hub.demo["modelFactory"] = () => {
      let turn = 0;
      return async () =>
        turn++ === 0
          ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "fetch_data", input: { url: "http://169.254.169.254/latest/meta-data" } }] }
          : { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] };
    };
    await s.api("POST", "/api/demo/run", {}, auth.token);
    await waitFor(s, "agent.finished");
    const result = s.hub.events.history().find((e) => e.type === "agent.step" && e.data.kind === "tool_result");
    assert.equal(result?.data.ok, false);
    assert.match(String(result?.data.summary), /can only reach/);
  } finally {
    await s.close();
  }
});
