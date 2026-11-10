export interface CreateOrderInput {
  amountCents: number;
  /** Our topup id, echoed back by PayPal so we can match the payment. */
  customId: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  /** PayPal-Request-Id: retrying with the same id never creates a second order. */
  requestId: string;
}

export interface CaptureResult {
  /** PayPal capture status: COMPLETED, PENDING, DECLINED, ... */
  status: string;
  captureId?: string;
  amountCents?: number;
  currency?: string;
  customId?: string;
}

export interface CreatePayoutInput {
  /** Our payout id. PayPal rejects a second batch with the same id. */
  senderBatchId: string;
  receiverEmail: string;
  amountCents: number;
  note: string;
}

export interface PayoutStatus {
  /** Batch status: PENDING, PROCESSING, SUCCESS, DENIED, CANCELED */
  batchStatus: string;
  /** Item status: SUCCESS, FAILED, PENDING, UNCLAIMED, RETURNED, ONHOLD, BLOCKED, REFUNDED, REVERSED */
  itemStatus?: string;
  error?: string;
}

export interface PayPalGateway {
  readonly mode: "sandbox" | "live" | "mock";
  createOrder(input: CreateOrderInput): Promise<{ orderId: string; approveUrl: string }>;
  captureOrder(orderId: string, requestId: string): Promise<CaptureResult>;
  createPayout(input: CreatePayoutInput): Promise<{ batchId: string; batchStatus: string }>;
  getPayout(batchId: string): Promise<PayoutStatus>;
}

export class PayPalError extends Error {
  constructor(
    public status: number,
    public name: string,
    message: string,
    public debugId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
