import { centsToMicros, microsToCents, microsToUsd } from "@tollgate/protocol";
import { type DB, newId, now, SYSTEM_ACCOUNTS, transaction } from "../db.ts";
import type { Ledger } from "../ledger.ts";
import type { EventBus } from "../events.ts";
import { PayPalError, type PayPalGateway } from "../paypal/index.ts";
import type { Participants } from "./participants.ts";
import { AppError, badRequest, notFound } from "../errors.ts";

export interface Payout {
  id: string;
  sellerId: string;
  amount: number;
  status: "processing" | "paid" | "unclaimed" | "failed";
  paypalBatchId: string | null;
  paypalItemStatus: string | null;
  txnId: string | null;
  reversalTxnId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const FAILED_ITEM_STATUSES = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "CANCELED"]);
const FAILED_BATCH_STATUSES = new Set(["DENIED", "CANCELED"]);

/**
 * Sellers withdraw what agents paid them, in one PayPal payout.
 *
 * The amount is moved out of the seller's ledger account *before* calling PayPal,
 * so a seller can never be paid twice for the same money. If PayPal rejects or
 * later fails the payout, a reversal txn puts the money back.
 */
export class Payouts {
  constructor(
    private db: DB,
    private ledger: Ledger,
    private participants: Participants,
    private paypal: PayPalGateway,
    private events: EventBus,
    private minPayout: number,
  ) {}

  /** Pays out the given amount, or the whole withdrawable balance (whole cents only). */
  async request(sellerId: string, amount?: number): Promise<Payout> {
    const seller = this.participants.getSeller(sellerId);
    if (!seller.paypalEmail) throw badRequest("Seller has no PayPal email for payouts");

    const balance = this.ledger.balance(seller.accountId);
    const cents = microsToCents(amount ?? balance);
    const payAmount = centsToMicros(cents);
    if (payAmount < this.minPayout) {
      throw badRequest(`Minimum payout is $${microsToUsd(this.minPayout)}. Available: $${microsToUsd(balance)}`);
    }

    const id = newId("pay");
    transaction(this.db, () => {
      const { txnId } = this.ledger.post({
        type: "payout",
        idempotencyKey: `payout:${id}`,
        memo: `PayPal payout to ${seller.name}`,
        meta: { payoutId: id, sellerId },
        legs: [
          { accountId: seller.accountId, amount: -payAmount },
          { accountId: SYSTEM_ACCOUNTS.paypalOut, amount: payAmount },
        ],
      });
      this.db
        .prepare("INSERT INTO payouts (id, seller_id, amount, status, txn_id) VALUES (?, ?, ?, 'processing', ?)")
        .run(id, sellerId, payAmount, txnId);
    });
    this.events.publish("payout.created", { payoutId: id, sellerId, sellerName: seller.name, amount: payAmount });

    try {
      const batch = await this.paypal.createPayout({
        senderBatchId: id,
        receiverEmail: seller.paypalEmail,
        amountCents: cents,
        note: `Tollgate earnings for ${seller.name}`,
      });
      this.db
        .prepare("UPDATE payouts SET paypal_batch_id = ?, paypal_item_status = ?, updated_at = ? WHERE id = ?")
        .run(batch.batchId, batch.batchStatus, now(), id);
    } catch (err) {
      const message = err instanceof PayPalError ? `${err.name}: ${err.message}` : (err as Error).message;
      if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
        // PayPal definitely rejected it: give the money back to the seller.
        this.fail(id, message);
        throw new AppError(502, "payout_failed", `PayPal rejected the payout: ${message}`);
      }
      // Network error or PayPal 5xx: the payout may or may not exist on PayPal's side.
      // Keep the funds reserved instead of guessing, so the seller can't be paid twice.
      this.db.prepare("UPDATE payouts SET error = ?, updated_at = ? WHERE id = ?").run(`Unconfirmed: ${message}`, now(), id);
      throw new AppError(502, "payout_unconfirmed", `Could not confirm the payout with PayPal: ${message}`);
    }
    return this.get(id);
  }

  /** Checks PayPal for the latest status and settles or reverses the payout. */
  async refresh(id: string): Promise<Payout> {
    const payout = this.get(id);
    if (payout.status !== "processing" || !payout.paypalBatchId) return payout;

    const status = await this.paypal.getPayout(payout.paypalBatchId);
    const item = status.itemStatus ?? status.batchStatus;
    this.db.prepare("UPDATE payouts SET paypal_item_status = ?, updated_at = ? WHERE id = ?").run(item, now(), id);

    if (FAILED_ITEM_STATUSES.has(item) || FAILED_BATCH_STATUSES.has(status.batchStatus)) {
      this.fail(id, status.error ?? `PayPal status ${item}`);
    } else if (item === "SUCCESS" || item === "UNCLAIMED") {
      // UNCLAIMED: sent, but the receiver has no PayPal account yet. Money is out of Tollgate.
      const final = item === "SUCCESS" ? "paid" : "unclaimed";
      this.db.prepare("UPDATE payouts SET status = ?, updated_at = ? WHERE id = ?").run(final, now(), id);
      this.events.publish(`payout.${final}`, { payoutId: id, sellerId: payout.sellerId, amount: payout.amount });
    }
    return this.get(id);
  }

  /** Refreshes every payout still processing. Called on a timer by the server. */
  async refreshAll(): Promise<void> {
    const rows = this.db.prepare("SELECT id FROM payouts WHERE status = 'processing' AND paypal_batch_id IS NOT NULL").all() as {
      id: string;
    }[];
    for (const { id } of rows) {
      try {
        await this.refresh(id);
      } catch (err) {
        console.warn(`Could not refresh payout ${id}: ${(err as Error).message}`);
      }
    }
  }

  get(id: string): Payout {
    const row = this.db.prepare("SELECT * FROM payouts WHERE id = ?").get(id) as PayoutRow | undefined;
    if (!row) throw notFound("Payout");
    return toPayout(row);
  }

  list(limit = 50, sellerId?: string): Payout[] {
    const rows = sellerId
      ? this.db.prepare("SELECT * FROM payouts WHERE seller_id = ? ORDER BY created_at DESC LIMIT ?").all(sellerId, limit)
      : this.db.prepare("SELECT * FROM payouts ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as unknown as PayoutRow[]).map(toPayout);
  }

  /** Marks the payout failed and returns the money to the seller (exactly once). */
  private fail(id: string, error: string) {
    const payout = this.get(id);
    const seller = this.participants.getSeller(payout.sellerId);
    transaction(this.db, () => {
      const { txnId } = this.ledger.post({
        type: "payout_reversal",
        idempotencyKey: `payout-reversal:${id}`,
        memo: `Payout to ${seller.name} failed, funds returned`,
        meta: { payoutId: id, error },
        legs: [
          { accountId: SYSTEM_ACCOUNTS.paypalOut, amount: -payout.amount },
          { accountId: seller.accountId, amount: payout.amount },
        ],
      });
      this.db
        .prepare("UPDATE payouts SET status = 'failed', reversal_txn_id = ?, error = ?, updated_at = ? WHERE id = ?")
        .run(txnId, error, now(), id);
    });
    this.events.publish("payout.failed", { payoutId: id, sellerId: seller.id, sellerName: seller.name, amount: payout.amount, error });
  }
}

interface PayoutRow {
  id: string;
  seller_id: string;
  amount: number;
  status: Payout["status"];
  paypal_batch_id: string | null;
  paypal_item_status: string | null;
  txn_id: string | null;
  reversal_txn_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const toPayout = (r: PayoutRow): Payout => ({
  id: r.id,
  sellerId: r.seller_id,
  amount: r.amount,
  status: r.status,
  paypalBatchId: r.paypal_batch_id,
  paypalItemStatus: r.paypal_item_status,
  txnId: r.txn_id,
  reversalTxnId: r.reversal_txn_id,
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
