/** Typed client for the Tollgate hub's admin API. All amounts are integer micros (1 USD = 1,000,000). */

export interface Policy {
  dailyLimit: number;
  maxPerRequest: number;
  approvalAbove: number;
  allowedHosts: string[];
}
export interface Agent {
  id: string;
  name: string;
  accountId: string;
  policy: Policy;
  balance: number;
  spentToday: number;
}
export interface Seller {
  id: string;
  name: string;
  accountId: string;
  paypalEmail: string | null;
  balance: number;
}
export interface Overview {
  hubUrl?: string;
  paypalMode: "sandbox" | "live" | "mock";
  feeBps: number;
  agents: Agent[];
  sellers: Seller[];
  audit: { ok: boolean; txnCount: number };
}
export interface Approval {
  id: string;
  agentId: string;
  sellerId: string;
  amount: number;
  url: string;
  description: string | null;
  status: string;
  expiresAt: string;
  createdAt: string;
}
export interface Payout {
  id: string;
  sellerId: string;
  amount: number;
  status: "processing" | "paid" | "unclaimed" | "failed";
  error: string | null;
  createdAt: string;
}
export interface Txn {
  id: string;
  type: string;
  meta: Record<string, unknown> | null;
  createdAt: string;
  entries: { accountId: string; amount: number }[];
}
export interface HubEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, any>;
}

export class AuthError extends Error {}

export const EVENT_TYPES = [
  "charge.completed",
  "payment.declined",
  "approval.requested",
  "approval.approved",
  "approval.denied",
  "topup.created",
  "topup.completed",
  "payout.created",
  "payout.paid",
  "payout.unclaimed",
  "payout.failed",
];

export class HubApi {
  constructor(private token: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new AuthError("Wrong admin token");
    if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
    return data as T;
  }

  overview = () => this.call<Overview>("GET", "/api/overview");
  pendingApprovals = () => this.call<{ approvals: Approval[] }>("GET", "/api/approvals?status=pending").then((r) => r.approvals);
  approve = (id: string) => this.call("POST", `/api/approvals/${id}/approve`);
  deny = (id: string) => this.call("POST", `/api/approvals/${id}/deny`);
  topUp = (agentId: string, amountUsd: string) =>
    this.call<{ approveUrl: string }>("POST", `/api/agents/${agentId}/topups`, { amountUsd });
  updatePolicy = (agentId: string, patch: Partial<{ dailyLimitUsd: string; maxPerRequestUsd: string; approvalAboveUsd: string; allowedHosts: string[] }>) =>
    this.call("PATCH", `/api/agents/${agentId}/policy`, patch);
  payout = (sellerId: string) => this.call<{ payout: Payout }>("POST", `/api/sellers/${sellerId}/payouts`, {});
  payouts = () => this.call<{ payouts: Payout[] }>("GET", "/api/payouts").then((r) => r.payouts);
  txns = (accountId: string) => this.call<{ txns: Txn[] }>("GET", `/api/ledger/txns?accountId=${encodeURIComponent(accountId)}&limit=500`).then((r) => r.txns);

  /** Live events. The hub replays recent history first, so the timeline fills in immediately. */
  subscribe(onEvent: (e: HubEvent) => void, onStatus: (connected: boolean) => void): () => void {
    const source = new EventSource(`/api/events?token=${encodeURIComponent(this.token)}`);
    const handler = (msg: MessageEvent) => {
      try {
        onEvent(JSON.parse(msg.data));
      } catch {
        // ignore malformed events
      }
    };
    EVENT_TYPES.forEach((t) => source.addEventListener(t, handler as EventListener));
    source.onopen = () => onStatus(true);
    source.onerror = () => onStatus(false);
    return () => source.close();
  }
}

/** Formats micros as dollars: at least 2 decimals, up to 4 for sub-cent amounts. */
export function usd(micros: number, maxDecimals = 4): string {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros) / 1_000_000;
  let text = abs.toFixed(maxDecimals).replace(/0+$/, "");
  const [whole, frac = ""] = text.split(".");
  text = `${whole}.${frac.padEnd(2, "0")}`;
  return `${sign}$${text}`;
}

export const toUsdString = (micros: number) => (micros / 1_000_000).toFixed(2);
