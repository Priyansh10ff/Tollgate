import { createHash, randomBytes } from "node:crypto";
import { type DB, newId, transaction } from "../db.ts";
import type { Ledger } from "../ledger.ts";
import { notFound } from "../errors.ts";

/** Spending rules an agent's owner sets. Enforced on every payment. */
export interface AgentPolicy {
  /** Max total spend per UTC day, in micros. */
  dailyLimit: number;
  /** Max price for a single request, in micros. */
  maxPerRequest: number;
  /** Requests priced above this need a human to approve, in micros. */
  approvalAbove: number;
  /** If non-empty, the agent may only pay these hosts. */
  allowedHosts: string[];
}

export const DEFAULT_POLICY: AgentPolicy = {
  dailyLimit: 5_000_000, // $5.00
  maxPerRequest: 1_000_000, // $1.00
  approvalAbove: 250_000, // $0.25
  allowedHosts: [],
};

export interface Agent {
  id: string;
  name: string;
  /** User who owns this agent. null = created with the admin token. */
  ownerId: string | null;
  accountId: string;
  policy: AgentPolicy;
  createdAt: string;
}

export interface Seller {
  id: string;
  name: string;
  /** User who owns this seller. null = created with the admin token. */
  ownerId: string | null;
  accountId: string;
  paypalEmail: string | null;
  createdAt: string;
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
const newKey = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

/** Agents (who pay) and sellers (who get paid). API keys are only stored as hashes. */
export class Participants {
  constructor(
    private db: DB,
    private ledger: Ledger,
  ) {}

  createAgent(name: string, policy: Partial<AgentPolicy> = {}, ownerId: string | null = null): { agent: Agent; apiKey: string } {
    const apiKey = newKey("tg_agent");
    const id = newId("agt");
    const fullPolicy = { ...DEFAULT_POLICY, ...policy };
    transaction(this.db, () => {
      const accountId = this.ledger.createAccount("agent_wallet", `${name} wallet`);
      this.db
        .prepare("INSERT INTO agents (id, name, account_id, key_hash, policy, owner_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, accountId, hashKey(apiKey), JSON.stringify(fullPolicy), ownerId);
    });
    return { agent: this.getAgent(id), apiKey };
  }

  createSeller(name: string, paypalEmail?: string, ownerId: string | null = null): { seller: Seller; apiKey: string } {
    const apiKey = newKey("tg_seller");
    const id = newId("slr");
    transaction(this.db, () => {
      const accountId = this.ledger.createAccount("seller", `${name} earnings`);
      this.db
        .prepare("INSERT INTO sellers (id, name, account_id, paypal_email, key_hash, owner_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, name, accountId, paypalEmail ?? null, hashKey(apiKey), ownerId);
    });
    return { seller: this.getSeller(id), apiKey };
  }

  getAgent(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    if (!row) throw notFound("Agent");
    return toAgent(row);
  }

  getSeller(id: string): Seller {
    const row = this.db.prepare("SELECT * FROM sellers WHERE id = ?").get(id) as SellerRow | undefined;
    if (!row) throw notFound("Seller");
    return toSeller(row);
  }

  findAgentByKey(apiKey: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE key_hash = ?").get(hashKey(apiKey)) as AgentRow | undefined;
    return row && toAgent(row);
  }

  findSellerByKey(apiKey: string): Seller | undefined {
    const row = this.db.prepare("SELECT * FROM sellers WHERE key_hash = ?").get(hashKey(apiKey)) as SellerRow | undefined;
    return row && toSeller(row);
  }

  /** All agents, or only those owned by ownerId. */
  listAgents(ownerId?: string): (Agent & { balance: number })[] {
    const rows = (
      ownerId === undefined
        ? this.db.prepare("SELECT * FROM agents ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM agents WHERE owner_id = ? ORDER BY created_at").all(ownerId)
    ) as unknown as AgentRow[];
    return rows.map(toAgent).map((a) => ({ ...a, balance: this.ledger.balance(a.accountId) }));
  }

  /** All sellers, or only those owned by ownerId. */
  listSellers(ownerId?: string): (Seller & { balance: number })[] {
    const rows = (
      ownerId === undefined
        ? this.db.prepare("SELECT * FROM sellers ORDER BY created_at").all()
        : this.db.prepare("SELECT * FROM sellers WHERE owner_id = ? ORDER BY created_at").all(ownerId)
    ) as unknown as SellerRow[];
    return rows.map(toSeller).map((s) => ({ ...s, balance: this.ledger.balance(s.accountId) }));
  }

  /** Issues a new API key for an agent. The old key stops working immediately. */
  rotateAgentKey(agentId: string): { agent: Agent; apiKey: string } {
    this.getAgent(agentId);
    const apiKey = newKey("tg_agent");
    this.db.prepare("UPDATE agents SET key_hash = ? WHERE id = ?").run(hashKey(apiKey), agentId);
    return { agent: this.getAgent(agentId), apiKey };
  }

  updatePolicy(agentId: string, patch: Partial<AgentPolicy>): Agent {
    const agent = this.getAgent(agentId);
    const policy = { ...agent.policy, ...patch };
    this.db.prepare("UPDATE agents SET policy = ? WHERE id = ?").run(JSON.stringify(policy), agentId);
    return this.getAgent(agentId);
  }

  updateSellerEmail(sellerId: string, paypalEmail: string): Seller {
    this.getSeller(sellerId);
    this.db.prepare("UPDATE sellers SET paypal_email = ? WHERE id = ?").run(paypalEmail, sellerId);
    return this.getSeller(sellerId);
  }
}

interface AgentRow {
  id: string;
  name: string;
  owner_id: string | null;
  account_id: string;
  policy: string;
  created_at: string;
}
interface SellerRow {
  id: string;
  name: string;
  owner_id: string | null;
  account_id: string;
  paypal_email: string | null;
  created_at: string;
}

const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id ?? null,
  accountId: r.account_id,
  policy: { ...DEFAULT_POLICY, ...JSON.parse(r.policy) },
  createdAt: r.created_at,
});
const toSeller = (r: SellerRow): Seller => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id ?? null,
  accountId: r.account_id,
  paypalEmail: r.paypal_email,
  createdAt: r.created_at,
});
