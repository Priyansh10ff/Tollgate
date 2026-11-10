import { assertMicros } from "@tollgate/protocol";
import { type DB, transaction, newId, SYSTEM_ACCOUNTS } from "./db.ts";
import { AppError, InsufficientFundsError } from "./errors.ts";

export type AccountKind = "system" | "agent_wallet" | "seller";

export interface Leg {
  accountId: string;
  /** Signed micros: positive adds to the account, negative takes from it. */
  amount: number;
}

export interface PostInput {
  type: string;
  legs: Leg[];
  /** Posting twice with the same key returns the first txn instead of moving money again. */
  idempotencyKey?: string;
  memo?: string;
  meta?: Record<string, unknown>;
}

export interface PostResult {
  txnId: string;
  /** false when the idempotency key already existed and nothing was posted. */
  created: boolean;
}

export interface TxnView {
  id: string;
  type: string;
  memo: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  entries: { accountId: string; amount: number }[];
}

/**
 * Double-entry ledger. Every movement of money is a txn whose legs sum to zero,
 * so money is never created or destroyed inside Tollgate: it only enters through
 * PayPal top-ups (sys_paypal_in) and leaves through PayPal payouts (sys_paypal_out).
 *
 * Balances are always derived from entries, never stored, so they can't drift.
 * Non-system accounts can never go below zero.
 */
export class Ledger {
  constructor(private db: DB) {}

  createAccount(kind: Exclude<AccountKind, "system">, name: string): string {
    const id = newId(kind === "agent_wallet" ? "acct_agent" : "acct_seller");
    this.db.prepare("INSERT INTO accounts (id, kind, name) VALUES (?, ?, ?)").run(id, kind, name);
    return id;
  }

  balance(accountId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(amount), 0) AS balance FROM entries WHERE account_id = ?")
      .get(accountId) as { balance: number };
    return row.balance;
  }

  post(input: PostInput): PostResult {
    const legs = input.legs.filter((leg) => leg.amount !== 0);
    if (legs.length < 2) throw new AppError(500, "ledger_invalid", "A txn needs at least two non-zero legs");
    for (const leg of legs) assertMicros(leg.amount);
    const sum = legs.reduce((total, leg) => total + leg.amount, 0);
    if (sum !== 0) throw new AppError(500, "ledger_unbalanced", `Txn legs sum to ${sum}, expected 0`);

    return transaction(this.db, () => {
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare("SELECT id FROM txns WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as { id: string } | undefined;
        if (existing) return { txnId: existing.id, created: false };
      }

      // Combine legs per account so an account debited twice is checked once.
      const perAccount = new Map<string, number>();
      for (const leg of legs) perAccount.set(leg.accountId, (perAccount.get(leg.accountId) ?? 0) + leg.amount);
      for (const [accountId, change] of perAccount) {
        const account = this.db.prepare("SELECT kind FROM accounts WHERE id = ?").get(accountId) as
          | { kind: AccountKind }
          | undefined;
        if (!account) throw new AppError(500, "ledger_unknown_account", `Unknown account ${accountId}`);
        if (account.kind !== "system" && change < 0) {
          const balance = this.balance(accountId);
          if (balance + change < 0) throw new InsufficientFundsError(accountId, balance, -change);
        }
      }

      const txnId = newId("txn");
      this.db
        .prepare("INSERT INTO txns (id, type, idempotency_key, memo, meta) VALUES (?, ?, ?, ?, ?)")
        .run(txnId, input.type, input.idempotencyKey ?? null, input.memo ?? null, input.meta ? JSON.stringify(input.meta) : null);
      const insertEntry = this.db.prepare("INSERT INTO entries (txn_id, account_id, amount) VALUES (?, ?, ?)");
      for (const leg of legs) insertEntry.run(txnId, leg.accountId, leg.amount);
      return { txnId, created: true };
    });
  }

  recentTxns(limit = 50, accountId?: string): TxnView[] {
    const txns = (
      accountId
        ? this.db
            .prepare(
              `SELECT DISTINCT t.* FROM txns t JOIN entries e ON e.txn_id = t.id
               WHERE e.account_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`,
            )
            .all(accountId, limit)
        : this.db.prepare("SELECT * FROM txns ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit)
    ) as { id: string; type: string; memo: string | null; meta: string | null; created_at: string }[];

    const entriesFor = this.db.prepare("SELECT account_id, amount FROM entries WHERE txn_id = ? ORDER BY id");
    return txns.map((t) => ({
      id: t.id,
      type: t.type,
      memo: t.memo,
      meta: t.meta ? JSON.parse(t.meta) : null,
      createdAt: t.created_at,
      entries: (entriesFor.all(t.id) as { account_id: string; amount: number }[]).map((e) => ({
        accountId: e.account_id,
        amount: e.amount,
      })),
    }));
  }

  /** Number of transactions that touch any of these accounts. */
  countTxns(accountIds: string[]): number {
    if (accountIds.length === 0) return 0;
    const marks = accountIds.map(() => "?").join(",");
    const row = this.db.prepare(`SELECT COUNT(DISTINCT txn_id) AS c FROM entries WHERE account_id IN (${marks})`).get(...accountIds) as { c: number };
    return row.c;
  }

  /**
   * Audits the whole ledger: every txn balances, the global sum is zero,
   * and no wallet or seller account is negative.
   */
  audit(): {
    ok: boolean;
    txnCount: number;
    globalSum: number;
    unbalancedTxns: string[];
    negativeAccounts: string[];
    totals: { toppedUp: number; paidOut: number; fees: number; heldInWallets: number; owedToSellers: number };
  } {
    const unbalanced = this.db
      .prepare("SELECT txn_id FROM entries GROUP BY txn_id HAVING SUM(amount) <> 0")
      .all() as { txn_id: string }[];
    const negative = this.db
      .prepare(
        `SELECT a.id FROM accounts a JOIN entries e ON e.account_id = a.id
         WHERE a.kind <> 'system' GROUP BY a.id HAVING SUM(e.amount) < 0`,
      )
      .all() as { id: string }[];
    const globalSum = (this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM entries").get() as { s: number }).s;
    const txnCount = (this.db.prepare("SELECT COUNT(*) AS c FROM txns").get() as { c: number }).c;
    const sumKind = (kind: string) =>
      (
        this.db
          .prepare(
            "SELECT COALESCE(SUM(e.amount), 0) AS s FROM entries e JOIN accounts a ON a.id = e.account_id WHERE a.kind = ?",
          )
          .get(kind) as { s: number }
      ).s;

    return {
      ok: unbalanced.length === 0 && negative.length === 0 && globalSum === 0,
      txnCount,
      globalSum,
      unbalancedTxns: unbalanced.map((r) => r.txn_id),
      negativeAccounts: negative.map((r) => r.id),
      totals: {
        toppedUp: -this.balance(SYSTEM_ACCOUNTS.paypalIn),
        paidOut: this.balance(SYSTEM_ACCOUNTS.paypalOut),
        fees: this.balance(SYSTEM_ACCOUNTS.fees),
        heldInWallets: sumKind("agent_wallet"),
        owedToSellers: sumKind("seller"),
      },
    };
  }
}
