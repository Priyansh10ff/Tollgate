import { createHash } from "node:crypto";
import type { Quote } from "@tollgate/protocol";
import { type DB, newId, now } from "../db.ts";
import type { EventBus } from "../events.ts";
import { AppError, notFound } from "../errors.ts";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";

export interface Approval {
  id: string;
  agentId: string;
  sellerId: string;
  amount: number;
  resource: string;
  url: string;
  description: string | null;
  quoteHash: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  createdAt: string;
}

const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** Fingerprint of the exact quote a human approved. Paying a different quote needs a new approval. */
export function quoteHash(q: Quote): string {
  return createHash("sha256").update(JSON.stringify([q.seller, q.price, q.resource, q.url, q.nonce])).digest("base64url");
}

/** Human-in-the-loop approvals for payments above an agent's threshold. */
export class Approvals {
  constructor(
    private db: DB,
    private events: EventBus,
  ) {}

  /** Returns the open approval for this exact quote, or creates one. */
  request(input: { agentId: string; agentName: string; sellerId: string; sellerName: string; amount: number; quote: Quote; reason: string }): Approval {
    const hash = quoteHash(input.quote);
    const existing = this.db
      .prepare("SELECT * FROM approvals WHERE agent_id = ? AND quote_hash = ? AND status IN ('pending', 'approved') ORDER BY created_at DESC LIMIT 1")
      .get(input.agentId, hash) as ApprovalRow | undefined;
    if (existing) return this.expireIfStale(toApproval(existing));

    const id = newId("apr");
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (id, agent_id, seller_id, amount, resource, url, description, quote_hash, status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(id, input.agentId, input.sellerId, input.amount, input.quote.resource, input.quote.url, input.quote.description ?? null, hash, expiresAt);
    this.events.publish("approval.requested", {
      approvalId: id,
      agentId: input.agentId,
      agentName: input.agentName,
      sellerId: input.sellerId,
      sellerName: input.sellerName,
      amount: input.amount,
      url: input.quote.url,
      description: input.quote.description,
      reason: input.reason,
      expiresAt,
    });
    return this.get(id);
  }

  decide(id: string, decision: "approved" | "denied"): Approval {
    const approval = this.get(id);
    if (approval.status !== "pending") throw new AppError(409, "approval_closed", `Approval is already ${approval.status}`);
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(decision, now(), id);
    this.events.publish(`approval.${decision}`, { approvalId: id, agentId: approval.agentId, amount: approval.amount, url: approval.url });
    return this.get(id);
  }

  markUsed(id: string): void {
    this.db.prepare("UPDATE approvals SET status = 'used' WHERE id = ? AND status = 'approved'").run(id);
  }

  get(id: string): Approval {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    if (!row) throw notFound("Approval");
    return this.expireIfStale(toApproval(row));
  }

  list(status?: ApprovalStatus, limit = 50): Approval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as unknown as ApprovalRow[]).map(toApproval).map((a) => this.expireIfStale(a));
  }

  private expireIfStale(a: Approval): Approval {
    if ((a.status === "pending" || a.status === "approved") && Date.parse(a.expiresAt) < Date.now()) {
      this.db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(a.id);
      return { ...a, status: "expired" };
    }
    return a;
  }
}

interface ApprovalRow {
  id: string;
  agent_id: string;
  seller_id: string;
  amount: number;
  resource: string;
  url: string;
  description: string | null;
  quote_hash: string;
  status: ApprovalStatus;
  expires_at: string;
  decided_at: string | null;
  created_at: string;
}

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id,
  agentId: r.agent_id,
  sellerId: r.seller_id,
  amount: r.amount,
  resource: r.resource,
  url: r.url,
  description: r.description,
  quoteHash: r.quote_hash,
  status: r.status,
  expiresAt: r.expires_at,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
});
