import { SYSTEM_ACCOUNTS } from "../db.ts";
import type { Ledger } from "../ledger.ts";
import type { EventBus } from "../events.ts";
import type { Participants } from "./participants.ts";

export interface ChargeInput {
  agentId: string;
  sellerId: string;
  price: number;
  /** Same key → same charge. Protects against double-charging on retries. */
  idempotencyKey: string;
  memo?: string;
  meta?: Record<string, unknown>;
}

export interface ChargeResult {
  txnId: string;
  created: boolean;
  price: number;
  fee: number;
  sellerAmount: number;
  agentBalance: number;
}

/**
 * Moves money from an agent's wallet to a seller inside the ledger.
 * No PayPal call happens here: that's what makes sub-cent prices possible.
 * The seller receives the price minus the platform fee.
 */
export class Charges {
  constructor(
    private ledger: Ledger,
    private participants: Participants,
    private events: EventBus,
    private feeBps: number,
  ) {}

  fee(price: number): number {
    return Math.floor((price * this.feeBps) / 10_000);
  }

  charge(input: ChargeInput): ChargeResult {
    const agent = this.participants.getAgent(input.agentId);
    const seller = this.participants.getSeller(input.sellerId);
    const fee = this.fee(input.price);
    const sellerAmount = input.price - fee;

    const { txnId, created } = this.ledger.post({
      type: "charge",
      idempotencyKey: `charge:${input.idempotencyKey}`,
      memo: input.memo ?? `${agent.name} paid ${seller.name}`,
      meta: { agentId: agent.id, sellerId: seller.id, price: input.price, fee, ...input.meta },
      legs: [
        { accountId: agent.accountId, amount: -input.price },
        { accountId: seller.accountId, amount: sellerAmount },
        { accountId: SYSTEM_ACCOUNTS.fees, amount: fee },
      ],
    });

    const agentBalance = this.ledger.balance(agent.accountId);
    if (created) {
      this.events.publish("charge.completed", {
        txnId,
        agentId: agent.id,
        agentName: agent.name,
        sellerId: seller.id,
        sellerName: seller.name,
        price: input.price,
        fee,
        agentBalance,
        ...input.meta,
      });
    }
    return { txnId, created, price: input.price, fee, sellerAmount, agentBalance };
  }
}
