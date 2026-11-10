import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type DB = DatabaseSync;

/** System accounts that represent money outside Tollgate. They may go negative. */
export const SYSTEM_ACCOUNTS = {
  paypalIn: "sys_paypal_in", // money received from PayPal top-ups
  paypalOut: "sys_paypal_out", // money sent out through PayPal Payouts
  fees: "sys_fees", // Tollgate's platform fees
} as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('system', 'agent_wallet', 'seller')),
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS txns (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE,
  memo             TEXT,
  meta             TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Double-entry: every txn's entries sum to exactly zero.
CREATE TABLE IF NOT EXISTS entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id      TEXT NOT NULL REFERENCES txns(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  amount      INTEGER NOT NULL CHECK (amount <> 0),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS entries_by_account ON entries(account_id);
CREATE INDEX IF NOT EXISTS entries_by_txn ON entries(txn_id);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  account_id  TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  key_hash    TEXT NOT NULL UNIQUE,
  policy      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sellers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  account_id    TEXT NOT NULL UNIQUE REFERENCES accounts(id),
  paypal_email  TEXT,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS topups (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  amount           INTEGER NOT NULL,
  status           TEXT NOT NULL,
  paypal_order_id  TEXT UNIQUE,
  capture_id       TEXT,
  txn_id           TEXT REFERENCES txns(id),
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS payouts (
  id                 TEXT PRIMARY KEY,
  seller_id          TEXT NOT NULL REFERENCES sellers(id),
  amount             INTEGER NOT NULL,
  status             TEXT NOT NULL,
  paypal_batch_id    TEXT,
  paypal_item_status TEXT,
  txn_id             TEXT REFERENCES txns(id),
  reversal_txn_id    TEXT REFERENCES txns(id),
  error              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT OR IGNORE INTO accounts (id, kind, name) VALUES (?, 'system', ?)");
  insert.run(SYSTEM_ACCOUNTS.paypalIn, "PayPal top-ups");
  insert.run(SYSTEM_ACCOUNTS.paypalOut, "PayPal payouts");
  insert.run(SYSTEM_ACCOUNTS.fees, "Tollgate fees");
  return db;
}

const depth = new WeakMap<DB, number>();

/**
 * Runs fn inside a write transaction. Nested calls join the outer transaction.
 * BEGIN IMMEDIATE takes the write lock up front, so balance checks and the
 * writes that depend on them can't interleave with another writer.
 */
export function transaction<T>(db: DB, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function now(): string {
  return new Date().toISOString();
}
