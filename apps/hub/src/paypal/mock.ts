import { randomBytes } from "node:crypto";
import {
  PayPalError,
  type CaptureResult,
  type CreateOrderInput,
  type CreatePayoutInput,
  type PayPalGateway,
  type PayoutStatus,
} from "./types.ts";

interface MockOrder {
  id: string;
  input: CreateOrderInput;
  approved: boolean;
  captureId?: string;
}

/**
 * Simulated PayPal used for automated tests and offline development.
 * Approval happens on the hub's /mock-paypal page instead of paypal.com.
 * Payouts to any email containing "fail" fail, so the reversal path can be tested.
 */
export class PayPalMock implements PayPalGateway {
  readonly mode = "mock" as const;
  orders = new Map<string, MockOrder>();
  payouts = new Map<string, { input: CreatePayoutInput; checks: number }>();
  private byRequestId = new Map<string, string>();
  private batchIds = new Set<string>();

  constructor(private hubUrl: string) {}

  async createOrder(input: CreateOrderInput) {
    const existing = this.byRequestId.get(input.requestId);
    const id = existing ?? `MOCK-${randomBytes(6).toString("hex").toUpperCase()}`;
    if (!existing) {
      this.orders.set(id, { id, input, approved: false });
      this.byRequestId.set(input.requestId, id);
    }
    return { orderId: id, approveUrl: `${this.hubUrl}/mock-paypal/checkout/${id}` };
  }

  /** What the buyer does by clicking "Pay" on the checkout page. */
  approve(orderId: string): MockOrder {
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "Order not found");
    order.approved = true;
    return order;
  }

  async captureOrder(orderId: string): Promise<CaptureResult> {
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "Order not found");
    if (!order.approved) throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "Order not approved", undefined, [{ issue: "ORDER_NOT_APPROVED" }]);
    order.captureId ??= `MOCKCAP-${randomBytes(6).toString("hex").toUpperCase()}`;
    return {
      status: "COMPLETED",
      captureId: order.captureId,
      amountCents: order.input.amountCents,
      currency: "USD",
      customId: order.input.customId,
    };
  }

  async createPayout(input: CreatePayoutInput) {
    if (this.batchIds.has(input.senderBatchId)) {
      throw new PayPalError(400, "USER_BUSINESS_ERROR", "Batch with given sender_batch_id already exists");
    }
    this.batchIds.add(input.senderBatchId);
    const batchId = `MOCKBATCH-${randomBytes(6).toString("hex").toUpperCase()}`;
    this.payouts.set(batchId, { input, checks: 0 });
    return { batchId, batchStatus: "PENDING" };
  }

  async getPayout(batchId: string): Promise<PayoutStatus> {
    const payout = this.payouts.get(batchId);
    if (!payout) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "Payout not found");
    payout.checks++;
    if (payout.input.receiverEmail.includes("fail")) {
      return { batchStatus: "SUCCESS", itemStatus: "FAILED", error: "RECEIVER_UNREGISTERED: Simulated failure" };
    }
    return { batchStatus: "SUCCESS", itemStatus: "SUCCESS" };
  }
}
