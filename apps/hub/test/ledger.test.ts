import { test } from "node:test";
import assert from "node:assert/strict";
import { testHub } from "./helpers.ts";
import { SYSTEM_ACCOUNTS } from "../src/db.ts";
import { InsufficientFundsError } from "../src/errors.ts";

function fund(hub: ReturnType<typeof testHub>["hub"], accountId: string, amount: number) {
  hub.ledger.post({
    type: "topup",
    legs: [
      { accountId: SYSTEM_ACCOUNTS.paypalIn, amount: -amount },
      { accountId, amount },
    ],
  });
}

test("rejects unbalanced txns", () => {
  const { hub } = testHub();
  const { agent } = hub.participants.createAgent("A");
  assert.throws(
    () => hub.ledger.post({ type: "bad", legs: [{ accountId: SYSTEM_ACCOUNTS.paypalIn, amount: -5 }, { accountId: agent.accountId, amount: 4 }] }),
    /sum to -1/,
  );
});

test("a wallet can never go negative", () => {
  const { hub } = testHub();
  const { agent } = hub.participants.createAgent("A");
  const { seller } = hub.participants.createSeller("S");
  fund(hub, agent.accountId, 1_000);
  assert.throws(
    () => hub.charges.charge({ agentId: agent.id, sellerId: seller.id, price: 1_001, idempotencyKey: "k1" }),
    InsufficientFundsError,
  );
  assert.equal(hub.ledger.balance(agent.accountId), 1_000);
});

test("charges split the price between seller and fee, and are idempotent", () => {
  const { hub } = testHub(); // fee = 1%
  const { agent } = hub.participants.createAgent("A");
  const { seller } = hub.participants.createSeller("S");
  fund(hub, agent.accountId, 1_000_000);

  const first = hub.charges.charge({ agentId: agent.id, sellerId: seller.id, price: 30_000, idempotencyKey: "req-1" });
  const retry = hub.charges.charge({ agentId: agent.id, sellerId: seller.id, price: 30_000, idempotencyKey: "req-1" });

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.txnId, first.txnId);
  assert.equal(first.fee, 300);
  assert.equal(hub.ledger.balance(agent.accountId), 970_000);
  assert.equal(hub.ledger.balance(seller.accountId), 29_700);
  assert.equal(hub.ledger.balance(SYSTEM_ACCOUNTS.fees), 300);
});

test("thousands of sub-cent charges stay exact", () => {
  const { hub } = testHub();
  const { agent } = hub.participants.createAgent("A");
  const { seller } = hub.participants.createSeller("S");
  fund(hub, agent.accountId, 10_000_000); // $10
  for (let i = 0; i < 2_000; i++) {
    hub.charges.charge({ agentId: agent.id, sellerId: seller.id, price: 1_500, idempotencyKey: `r${i}` }); // $0.0015 each
  }
  assert.equal(hub.ledger.balance(agent.accountId), 7_000_000);
  const audit = hub.ledger.audit();
  assert.equal(audit.ok, true);
  assert.equal(audit.globalSum, 0);
  assert.equal(audit.totals.owedToSellers + audit.totals.fees, 3_000_000);
});
