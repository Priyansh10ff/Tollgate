import { centsToMicros, microsToCents, microsToUsd, MICROS_PER_CENT } from "@tollgate/protocol";
import { type DB, newId, now, SYSTEM_ACCOUNTS, transaction } from "../db.ts";
import type { Ledger } from "../ledger.ts";
import type { EventBus } from "../events.ts";
import type { PayPalGateway } from "../paypal/index.ts";
import type { Participants } from "./participants.ts";
import { AppError, badRequest, notFound } from "../errors.ts";

export const MIN_TOPUP = 1_000_000; // $1
export const MAX_TOPUP = 500_000_000; // $500

export interface Topup {
  id: string;
  agentId: string;
  amount: number;
  status: "created" | "completed" | "cancelled" | "failed" | "pending";
  paypalOrderId: string | null;
  captureId: string | null;
  txnId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Owner tops up an agent wallet through PayPal Checkout:
 *   start()    → creates a PayPal order and returns the approval link
 *   (buyer approves on PayPal, PayPal redirects to /paypal/return)
 *   complete() → captures the order and credits the wallet exactly once
 */
export class Topups {
  constructor(
    private db: DB,
    private ledger: Ledger,
    private participants: Participants,
    private paypal: PayPalGateway,
    private events: EventBus,
    private hubUrl: string,
  ) {}

  async start(agentId: string, amount: number): Promise<{ topup: Topup; approveUrl: string }> {
    const agent = this.participants.getAgent(agentId);
    if (amount % MICROS_PER_CENT !== 0) throw badRequest("Top-ups must be whole cents");
    if (amount < MIN_TOPUP || amount > MAX_TOPUP) {
      throw badRequest(`Top-up must be between $${microsToUsd(MIN_TOPUP)} and $${microsToUsd(MAX_TOPUP)}`);
    }

    const id = newId("top");
    this.db.prepare("INSERT INTO topups (id, agent_id, amount, status) VALUES (?, ?, ?, 'created')").run(id, agentId, amount);

    const order = await this.paypal.createOrder({
      amountCents: microsToCents(amount),
      customId: id,
      description: `Tollgate wallet top-up for ${agent.name}`,
      returnUrl: `${this.hubUrl}/paypal/return`,
      cancelUrl: `${this.hubUrl}/paypal/cancel`,
      requestId: id,
    });
    this.db.prepare("UPDATE topups SET paypal_order_id = ?, updated_at = ? WHERE id = ?").run(order.orderId, now(), id);

    this.events.publish("topup.created", { topupId: id, agentId, agentName: agent.name, amount });
    return { topup: this.get(id), approveUrl: order.approveUrl };
  }

  /** Captures the PayPal order and credits the wallet. Safe to call more than once. */
  async complete(orderId: string): Promise<Topup> {
    const topup = this.getByOrder(orderId);
    if (topup.status === "completed") return topup;
    if (topup.status === "cancelled") throw new AppError(409, "topup_cancelled", "This top-up was cancelled");

    const capture = await this.paypal.captureOrder(orderId, `cap_${topup.id}`);

    if (capture.status !== "COMPLETED") {
      const status = capture.status === "PENDING" ? "pending" : "failed";
      this.setStatus(topup.id, status, `PayPal capture status: ${capture.status}`);
      throw new AppError(409, "capture_not_completed", `PayPal capture is ${capture.status}`);
    }

    // Never trust the redirect alone: the captured money must match what we asked for.
    const expectedCents = microsToCents(topup.amount);
    const problems = [
      capture.currency !== "USD" && `currency ${capture.currency}`,
      capture.amountCents !== expectedCents && `amount ${capture.amountCents} cents, expected ${expectedCents}`,
      capture.customId && capture.customId !== topup.id && `custom_id ${capture.customId}`,
    ].filter(Boolean);
    if (problems.length) {
      this.setStatus(topup.id, "failed", `Capture mismatch: ${problems.join(", ")}`);
      throw new AppError(409, "capture_mismatch", "PayPal capture does not match this top-up", problems);
    }

    const agent = this.participants.getAgent(topup.agentId);
    const credited = centsToMicros(capture.amountCents!);
    transaction(this.db, () => {
      const { txnId } = this.ledger.post({
        type: "topup",
        idempotencyKey: `topup:${orderId}`,
        memo: `PayPal top-up for ${agent.name}`,
        meta: { topupId: topup.id, paypalOrderId: orderId, captureId: capture.captureId },
        legs: [
          { accountId: SYSTEM_ACCOUNTS.paypalIn, amount: -credited },
          { accountId: agent.accountId, amount: credited },
        ],
      });
      this.db
        .prepare("UPDATE topups SET status = 'completed', capture_id = ?, txn_id = ?, error = NULL, updated_at = ? WHERE id = ?")
        .run(capture.captureId ?? null, txnId, now(), topup.id);
    });

    const balance = this.ledger.balance(agent.accountId);
    this.events.publish("topup.completed", { topupId: topup.id, agentId: agent.id, agentName: agent.name, amount: credited, balance });
    return this.get(topup.id);
  }

  cancel(orderId: string): Topup {
    const topup = this.getByOrder(orderId);
    if (topup.status === "created") this.setStatus(topup.id, "cancelled", "Buyer cancelled on PayPal");
    return this.get(topup.id);
  }

  get(id: string): Topup {
    const row = this.db.prepare("SELECT * FROM topups WHERE id = ?").get(id) as TopupRow | undefined;
    if (!row) throw notFound("Top-up");
    return toTopup(row);
  }

  getByOrder(orderId: string): Topup {
    const row = this.db.prepare("SELECT * FROM topups WHERE paypal_order_id = ?").get(orderId) as TopupRow | undefined;
    if (!row) throw notFound("Top-up for this PayPal order");
    return toTopup(row);
  }

  list(limit = 50): Topup[] {
    return (this.db.prepare("SELECT * FROM topups ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as TopupRow[]).map(toTopup);
  }

  private setStatus(id: string, status: Topup["status"], error: string | null) {
    this.db.prepare("UPDATE topups SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, now(), id);
  }
}

interface TopupRow {
  id: string;
  agent_id: string;
  amount: number;
  status: Topup["status"];
  paypal_order_id: string | null;
  capture_id: string | null;
  txn_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toTopup = (r: TopupRow): Topup => ({
  id: r.id,
  agentId: r.agent_id,
  amount: r.amount,
  status: r.status,
  paypalOrderId: r.paypal_order_id,
  captureId: r.capture_id,
  txnId: r.txn_id,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
