import { normalizeBaseUrl, PROTOCOL_VERSION, RECEIPT_HEADER, usdToMicros, type PaymentRequiredBody, type Quote } from "@tollgate/protocol";

export type TollgateEvent =
  | { type: "payment_required"; quote: Quote }
  | { type: "paid"; quote: Quote; receiptId: string; amount: number; balance: number; alreadyPaid: boolean }
  | { type: "approval_pending"; quote: Quote; approvalId: string; reason: string }
  | { type: "approval_granted"; quote: Quote; approvalId: string }
  | { type: "declined"; quote: Quote; code: string; message: string };

export interface TollgateClientOptions {
  /** The agent's Tollgate hub. */
  hubUrl: string;
  /** The agent's API key (tg_agent_...). */
  agentKey: string;
  /** Underlying fetch. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Extra local cap: never even ask the hub to pay more than this per request (USD). */
  maxPriceUsd?: string;
  /** How long to wait for a human to approve a payment. Default 5 minutes. */
  approvalTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Called on every payment step: useful for logs and UIs. */
  onEvent?: (event: TollgateEvent) => void;
}

export interface Wallet {
  agentId: string;
  name: string;
  balance: number;
  spentToday: number;
  policy: { dailyLimit: number; maxPerRequest: number; approvalAbove: number; allowedHosts: string[] };
}

export class TollgatePaymentError extends Error {
  constructor(
    public code: string,
    message: string,
    public quote?: Quote,
  ) {
    super(message);
    this.name = "TollgatePaymentError";
  }
}

/**
 * A wallet for an AI agent.
 *
 *   const tollgate = new TollgateClient({ hubUrl, agentKey });
 *   const res = await tollgate.fetch("https://api.example.com/v1/report");
 *
 * When a server answers 402 with a Tollgate quote, the client checks the quote,
 * asks the hub to pay (the hub enforces the owner's spending rules), waits for a
 * human if approval is needed, and retries the request with the signed receipt.
 * Request bodies must be re-sendable (string, Buffer, URLSearchParams...).
 */
export class TollgateClient {
  private hubUrl: string;
  private baseFetch: typeof fetch;

  constructor(private options: TollgateClientOptions) {
    this.hubUrl = options.hubUrl.replace(/\/+$/, "");
    this.baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = input.toString();
    const first = await this.baseFetch(url, init);
    if (first.status !== 402) return first;

    const body = (await first
      .clone()
      .json()
      .catch(() => null)) as PaymentRequiredBody | null;
    if (!body?.tollgate) return first; // a 402 that isn't Tollgate: leave it to the caller

    const quote = body.tollgate;
    this.checkQuote(quote, url);
    this.emit({ type: "payment_required", quote });

    const receipt = await this.pay(quote);
    const headers = new Headers(init.headers);
    headers.set(RECEIPT_HEADER, receipt);
    const paid = await this.baseFetch(url, { ...init, headers });

    if (paid.status === 402) {
      const again = (await paid.json().catch(() => null)) as PaymentRequiredBody | null;
      throw new TollgatePaymentError(
        again?.receiptError?.code ?? "receipt_rejected",
        `Seller rejected the receipt: ${again?.receiptError?.message ?? "unknown reason"}`,
        quote,
      );
    }
    return paid;
  };

  /** Pays a quote through the hub and returns the receipt token. */
  async pay(quote: Quote): Promise<string> {
    let approvalId: string | undefined;
    for (;;) {
      const res = await this.hub("POST", "/v1/pay", { quote, approvalId });
      if (res.status === 200) {
        this.emit({ type: "paid", quote, receiptId: res.body.receiptId, amount: res.body.amount, balance: res.body.balance, alreadyPaid: res.body.alreadyPaid });
        return res.body.receipt;
      }
      if (res.status === 202 && !approvalId) {
        approvalId = res.body.approvalId as string;
        this.emit({ type: "approval_pending", quote, approvalId, reason: res.body.reason });
        await this.waitForApproval(quote, approvalId);
        this.emit({ type: "approval_granted", quote, approvalId });
        continue;
      }
      const code = res.body?.error?.code ?? `http_${res.status}`;
      const message = res.body?.error?.message ?? "Payment failed";
      this.emit({ type: "declined", quote, code, message });
      throw new TollgatePaymentError(code, message, quote);
    }
  }

  async wallet(): Promise<Wallet> {
    const res = await this.hub("GET", "/v1/wallet");
    if (res.status !== 200) throw new TollgatePaymentError(res.body?.error?.code ?? "wallet_error", res.body?.error?.message ?? "Could not read wallet");
    return res.body;
  }

  private checkQuote(quote: Quote, requestUrl: string) {
    const fail = (code: string, message: string): never => {
      this.emit({ type: "declined", quote, code, message });
      throw new TollgatePaymentError(code, message, quote);
    };
    if (quote.version !== PROTOCOL_VERSION) fail("unsupported_version", `Unsupported Tollgate version ${quote.version}`);
    if (normalizeBaseUrl(quote.hub) !== normalizeBaseUrl(this.hubUrl)) {
      fail("unknown_hub", `Seller wants payment through ${quote.hub}, but this agent's wallet is at ${this.hubUrl}`);
    }
    // A seller can only charge for its own URLs, not pretend to be another site.
    if (new URL(quote.url).host !== new URL(requestUrl).host) {
      fail("quote_host_mismatch", `Quote is for ${new URL(quote.url).host}, but the request went to ${new URL(requestUrl).host}`);
    }
    if (this.options.maxPriceUsd && usdToMicros(quote.price) > usdToMicros(this.options.maxPriceUsd)) {
      fail("client_max_price", `$${quote.price} is above this client's $${this.options.maxPriceUsd} limit`);
    }
  }

  private async waitForApproval(quote: Quote, approvalId: string) {
    const deadline = Date.now() + (this.options.approvalTimeoutMs ?? 5 * 60_000);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.options.pollIntervalMs ?? 1500));
      const res = await this.hub("GET", `/v1/approvals/${approvalId}`);
      const status = res.body?.approval?.status;
      if (status === "approved") return;
      if (status && status !== "pending") {
        const code = status === "denied" ? "approval_denied" : `approval_${status}`;
        const message = status === "denied" ? "The owner denied this payment" : `Approval ${status}`;
        this.emit({ type: "declined", quote, code, message });
        throw new TollgatePaymentError(code, message, quote);
      }
    }
    this.emit({ type: "declined", quote, code: "approval_timeout", message: "Timed out waiting for approval" });
    throw new TollgatePaymentError("approval_timeout", "Timed out waiting for the owner to approve", quote);
  }

  private async hub(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await this.baseFetch(`${this.hubUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.options.agentKey}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  private emit(event: TollgateEvent) {
    try {
      this.options.onEvent?.(event);
    } catch {
      // A broken listener must not break payments.
    }
  }
}
