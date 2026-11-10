import { centsToPayPalValue, payPalValueToCents } from "@tollgate/protocol";
import {
  PayPalError,
  type CaptureResult,
  type CreateOrderInput,
  type CreatePayoutInput,
  type PayPalGateway,
  type PayoutStatus,
} from "./types.ts";

interface Options {
  clientId: string;
  clientSecret: string;
  apiBase: string;
  mode: "sandbox" | "live";
}

/** Talks to the real PayPal REST API (Orders v2 and Payouts v1). */
export class PayPalRest implements PayPalGateway {
  readonly mode: "sandbox" | "live";
  private token?: { value: string; expiresAt: number };

  constructor(private options: Options) {
    this.mode = options.mode;
  }

  async createOrder(input: CreateOrderInput) {
    const order = await this.request<{ id: string; links?: { rel: string; href: string }[] }>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: input.customId,
            custom_id: input.customId,
            description: input.description,
            amount: { currency_code: "USD", value: centsToPayPalValue(input.amountCents) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: "Tollgate",
              user_action: "PAY_NOW",
              shipping_preference: "NO_SHIPPING",
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      },
      { "PayPal-Request-Id": input.requestId },
    );
    const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
    if (!approve) throw new PayPalError(502, "NO_APPROVE_LINK", "PayPal did not return an approval link");
    return { orderId: order.id, approveUrl: approve.href };
  }

  async captureOrder(orderId: string, requestId: string): Promise<CaptureResult> {
    try {
      const order = await this.request<PayPalOrder>(
        "POST",
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        undefined,
        { "PayPal-Request-Id": requestId, Prefer: "return=representation" },
      );
      return readCapture(order);
    } catch (err) {
      // Already captured (e.g. the buyer refreshed the return page): read the order instead.
      if (err instanceof PayPalError && JSON.stringify(err.details ?? "").includes("ORDER_ALREADY_CAPTURED")) {
        const order = await this.request<PayPalOrder>("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
        return readCapture(order);
      }
      throw err;
    }
  }

  async createPayout(input: CreatePayoutInput) {
    const res = await this.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: {
          sender_batch_id: input.senderBatchId,
          email_subject: "You have a payout from Tollgate",
          email_message: "Your earnings from AI agent requests have been paid out.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            receiver: input.receiverEmail,
            amount: { value: centsToPayPalValue(input.amountCents), currency: "USD" },
            note: input.note,
            sender_item_id: input.senderBatchId,
          },
        ],
      },
    );
    return { batchId: res.batch_header.payout_batch_id, batchStatus: res.batch_header.batch_status };
  }

  async getPayout(batchId: string): Promise<PayoutStatus> {
    const res = await this.request<{
      batch_header: { batch_status: string };
      items?: { transaction_status?: string; errors?: { name?: string; message?: string } }[];
    }>("GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
    const item = res.items?.[0];
    return {
      batchStatus: res.batch_header.batch_status,
      itemStatus: item?.transaction_status,
      error: item?.errors ? [item.errors.name, item.errors.message].filter(Boolean).join(": ") : undefined,
    };
  }

  // ── HTTP ────────────────────────────────────────────────────

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const auth = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    const res = await fetch(`${this.options.apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(res.status, "AUTH_FAILED", "PayPal rejected the client ID or secret");
    const data = (await res.json()) as { access_token: string; expires_in: number };
    // Refresh a minute early so a token never expires mid-request.
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.options.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new PayPalError(
        res.status,
        data.name ?? "PAYPAL_ERROR",
        data.message ?? `PayPal returned HTTP ${res.status}`,
        data.debug_id,
        data.details,
      );
    }
    return data as T;
  }
}

interface PayPalOrder {
  status: string;
  purchase_units?: {
    custom_id?: string;
    payments?: {
      captures?: { id: string; status: string; custom_id?: string; amount: { value: string; currency_code: string } }[];
    };
  }[];
}

function readCapture(order: PayPalOrder): CaptureResult {
  const unit = order.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (!capture) return { status: order.status };
  return {
    status: capture.status,
    captureId: capture.id,
    amountCents: payPalValueToCents(capture.amount.value),
    currency: capture.amount.currency_code,
    customId: capture.custom_id ?? unit?.custom_id,
  };
}
