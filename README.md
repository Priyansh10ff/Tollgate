# Tollgate

**Pay-per-request for AI agents, settled through PayPal.**

AI agents browse websites and call APIs all day, but they can't pay for anything, and the people who run those sites and APIs have no way to charge them. Tollgate fixes both sides:

- **Sellers** add one line to their API. Requests from agents without payment get an `HTTP 402 Payment Required` response with a price.
- **Agents** get a wallet, funded through PayPal, that pays automatically within the spending limits their owner sets.
- **Tiny payments work** because each charge is recorded in a ledger instead of going through PayPal one by one. Sellers' earnings are paid out in batches with PayPal Payouts.

> 🚧 Work in progress.

## How it works

```
Agent ──GET /data──────────────▶ Seller API
      ◀─402 Payment Required ── (price: $0.03)

Agent ──pay $0.03──────────────▶ Tollgate hub ── checks spending rules
      ◀─signed receipt ───────    debits wallet, credits seller in ledger

Agent ──GET /data + receipt ───▶ Seller API ── verifies receipt
      ◀─200 OK + data ─────────

Owner tops up wallet ───────────▶ PayPal Orders API
Seller withdraws earnings ◀───── PayPal Payouts API
```

### Why a ledger?

A PayPal transaction for $0.003 would cost more in fees than the payment itself. Tollgate collects money from agent owners in normal-sized PayPal top-ups, records every tiny charge in a **double-entry ledger**, and pays sellers in batches.

- Amounts are integer **micros** (1 USD = 1,000,000), so prices like `$0.0015` are exact. No floating point.
- Every transaction's entries sum to zero, so money is never created or lost. Balances are always computed from entries, never stored.
- Wallets can never go negative. Balance checks and writes happen in one locked SQLite transaction.
- Top-ups, charges, payouts and reversals are **idempotent**: retries and page refreshes never move money twice.
- PayPal captures are verified (amount, currency, order reference) before a wallet is credited.
- Payout funds are reserved before calling PayPal. If PayPal rejects or later fails the payout, a reversal returns the money to the seller exactly once.

`GET /api/ledger/audit` checks all of this at any time.

## Project layout

```
apps/hub            wallets, ledger, PayPal top-ups and payouts (Express + SQLite)
packages/protocol   shared money helpers and types
scripts/            setup checker and command-line tool
```

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`)
- A PayPal developer account with a sandbox app (Payouts enabled)
- A Claude API key (for the demo agent)

## Setup

```bash
npm install
cp .env.example .env      # then fill in your keys
npm run check-setup       # verifies Node, PayPal and Claude settings
```

Without PayPal keys, the hub runs with a **simulated PayPal** so you can try everything offline.

## Try the money flow

Start the hub in one terminal:

```bash
npm run hub
```

In another terminal:

```bash
npm run try setup            # create a demo agent and seller
npm run try topup 10         # top up the agent's wallet with $10 (opens PayPal checkout)
npm run try charge 0.03 100  # simulate 100 paid requests at $0.03
npm run try payout           # pay the seller's earnings out through PayPal
npm run try status           # balances, top-ups, payouts and the ledger audit
```

In the PayPal sandbox checkout, log in with a sandbox **Personal** account.

## Tests

```bash
npm test
```

## API

All admin endpoints need `Authorization: Bearer <HUB_ADMIN_TOKEN>`. Amounts in JSON are integer micros unless the field name ends in `Usd`.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agents` | Create an agent wallet `{ name, policy? }`. Returns its API key once. |
| `PATCH` | `/api/agents/:id/policy` | Update spending limits |
| `POST` | `/api/agents/:id/topups` | Start a PayPal top-up `{ amountUsd }`. Returns the approval link. |
| `POST` | `/api/sellers` | Create a seller `{ name, paypalEmail }`. Returns its API key once. |
| `POST` | `/api/sellers/:id/payouts` | Pay out earnings via PayPal Payouts `{ amountUsd? }` |
| `POST` | `/api/payouts/:id/refresh` | Sync a payout's status with PayPal |
| `GET` | `/api/overview` | Agents, sellers, balances and ledger audit |
| `GET` | `/api/ledger/txns` | Recent ledger transactions |
| `GET` | `/api/ledger/audit` | Verify the ledger balances |
| `GET` | `/api/events` | Live event stream (Server-Sent Events) |
| `GET` | `/paypal/return` | Where PayPal sends the buyer after approving a top-up |

## License

[MIT](LICENSE)
