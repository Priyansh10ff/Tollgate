import { z } from "zod";
import {
  microsToUsd,
  normalizeBaseUrl,
  PROTOCOL_VERSION,
  RECEIPT_TTL_SECONDS,
  signReceipt,
  usdToMicros,
  type Quote,
} from "@tollgate/protocol";
import { type DB, newId, transaction } from "../db.ts";
import type { Ledger } from "../ledger.ts";
import type { EventBus } from "../events.ts";
import type { SigningKey } from "../keys.ts";
import { AppError, InsufficientFundsError } from "../errors.ts";
import type { Agent, Participants } from "./participants.ts";
import type { Charges } from "./charges.ts";
import { type Approval, type Approvals, quoteHash } from "./approvals.ts";
import { evaluatePolicy } from "./policy.ts";

export const quoteSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  hub: z.url(),
  seller: z.string().min(1).max(64),
  price: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/, "price must be a USD decimal string"),
  currency: z.literal("USD"),
  resource: z.string().min(3).max(2048),
  url: z.url().max(4096),
  description: z.string().max(300).optional(),
  nonce: z.string().min(8).max(128),
});

export type PayResult =
  | {
      status: "paid";
      receipt: string;
      receiptId: string;
      txnId: string;
      amount: number;
      balance: number;
      /** true when this quote had already been paid and the existing receipt is returned. */
      alreadyPaid: boolean;
    }
  | { status: "approval_required"; approvalId: string; expiresAt: string; reason: string };

/**
 * Turns a seller's quote into a signed receipt:
 * validate → spending rules → (human approval) → charge wallet → sign receipt.
 * Checks and the charge run in one transaction, so concurrent requests
 * can't slip past the daily limit together.
 */
export class Payments {
  constructor(
    private db: DB,
    private ledger: Ledger,
    private participants: Participants,
    private charges: Charges,
    private approvals: Approvals,
    private events: EventBus,
    private key: SigningKey,
    private hubUrl: string,
  ) {}

  pay(agent: Agent, rawQuote: unknown, approvalId?: string): PayResult {
    const quote = quoteSchema.parse(rawQuote) as Quote;
    if (normalizeBaseUrl(quote.hub) !== normalizeBaseUrl(this.hubUrl)) {
      throw new AppError(400, "wrong_hub", `This quote is for hub ${quote.hub}, not ${this.hubUrl}`);
    }
    const seller = this.participants.getSeller(quote.seller);
    const price = usdToMicros(quote.price);
    if (price <= 0) throw new AppError(400, "bad_price", "Price must be greater than zero");
    const host = new URL(quote.url).host;
    const paymentKey = `${agent.id}:${seller.id}:${quote.nonce}`;

    return transaction(this.db, (): PayResult => {
      // Same quote paid before (agent retried): hand back the same receipt, charge nothing.
      const existing = this.db.prepare("SELECT * FROM receipts WHERE payment_key = ?").get(paymentKey) as ReceiptRow | undefined;
      if (existing) {
        return {
          status: "paid",
          receipt: existing.token,
          receiptId: existing.id,
          txnId: existing.txn_id,
          amount: existing.amount,
          balance: this.ledger.balance(agent.accountId),
          alreadyPaid: true,
        };
      }

      const decline = (code: string, reason: string, status = 403): never => {
        this.events.publish("payment.declined", {
          agentId: agent.id,
          agentName: agent.name,
          sellerId: seller.id,
          sellerName: seller.name,
          amount: price,
          url: quote.url,
          description: quote.description,
          code,
          reason,
        });
        throw new AppError(status, code, reason);
      };

      const decision = evaluatePolicy({ policy: agent.policy, price, host, spentToday: this.spentToday(agent) });
      if (decision.action === "deny") decline(decision.code, decision.reason);

      let approval: Approval | undefined;
      if (decision.action === "approve") {
        approval = approvalId
          ? this.approvals.get(approvalId)
          : this.approvals.request({
              agentId: agent.id,
              agentName: agent.name,
              sellerId: seller.id,
              sellerName: seller.name,
              amount: price,
              quote,
              reason: decision.reason,
            });
        if (approval.agentId !== agent.id || approval.quoteHash !== quoteHash(quote)) {
          decline("approval_mismatch", "This approval was given for a different payment");
        }
        if (approval.status === "pending") {
          return { status: "approval_required", approvalId: approval.id, expiresAt: approval.expiresAt, reason: decision.reason };
        }
        if (approval.status === "denied") decline("approval_denied", "The owner denied this payment");
        if (approval.status !== "approved") decline(`approval_${approval.status}`, `Approval is ${approval.status}`);
      }

      const receiptId = newId("rcpt");
      let charge;
      try {
        charge = this.charges.charge({
          agentId: agent.id,
          sellerId: seller.id,
          price,
          idempotencyKey: paymentKey,
          memo: `${agent.name} → ${seller.name}: ${quote.description ?? quote.resource}`,
          meta: { receiptId, resource: quote.resource, url: quote.url, host, description: quote.description, approvalId: approval?.id },
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          decline("insufficient_funds", `Wallet has $${microsToUsd(this.ledger.balance(agent.accountId))}, needs $${microsToUsd(price)}`, 402);
        }
        throw err;
      }

      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + RECEIPT_TTL_SECONDS;
      const token = signReceipt(
        { iss: this.hubUrl, sub: agent.id, aud: seller.id, jti: receiptId, amt: price, res: quote.resource, txn: charge.txnId, iat, exp },
        this.key.privateKey,
        this.key.kid,
      );
      this.db
        .prepare(
          `INSERT INTO receipts (id, agent_id, seller_id, amount, resource, url, payment_key, txn_id, token, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(receiptId, agent.id, seller.id, price, quote.resource, quote.url, paymentKey, charge.txnId, token, exp);
      if (approval) this.approvals.markUsed(approval.id);

      return {
        status: "paid",
        receipt: token,
        receiptId,
        txnId: charge.txnId,
        amount: price,
        balance: charge.agentBalance,
        alreadyPaid: false,
      };
    });
  }

  /** Total paid by the agent since midnight UTC, in micros. */
  spentToday(agent: Agent): number {
    const midnight = new Date();
    midnight.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare(
        `SELECT COALESCE(-SUM(e.amount), 0) AS spent FROM entries e JOIN txns t ON t.id = e.txn_id
         WHERE e.account_id = ? AND t.type = 'charge' AND t.created_at >= ?`,
      )
      .get(agent.accountId, midnight.toISOString()) as { spent: number };
    return row.spent;
  }

  recentReceipts(limit = 50): Omit<ReceiptRow, "token" | "payment_key">[] {
    return this.db
      .prepare("SELECT id, agent_id, seller_id, amount, resource, url, txn_id, expires_at, created_at FROM receipts ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as Omit<ReceiptRow, "token" | "payment_key">[];
  }
}

interface ReceiptRow {
  id: string;
  agent_id: string;
  seller_id: string;
  amount: number;
  resource: string;
  url: string;
  payment_key: string;
  txn_id: string;
  token: string;
  expires_at: number;
  created_at: string;
}
