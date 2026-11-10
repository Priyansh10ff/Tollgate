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

## Charge agents in one line (sellers)

```ts
import { tollgate } from "@tollgate/express";

app.get(
  "/v1/companies/:name",
  tollgate({ hubUrl: "https://hub.example.com", sellerId: "slr_...", price: "0.03", description: "Company profile" }),
  (req, res) => res.json({ ...data, paidBy: req.tollgate?.sub }),
);
```

Requests without a valid receipt get `402 Payment Required` with a quote. `price` can also be a function of the request; return `null` to make a request free.

## Give an agent a wallet

```ts
import { TollgateClient } from "@tollgate/client";

const tollgate = new TollgateClient({ hubUrl: "https://hub.example.com", agentKey: process.env.TOLLGATE_AGENT_KEY });
const res = await tollgate.fetch("https://api.example.com/v1/companies/acme"); // pays if needed
```

`tollgate.fetch` works like `fetch`. On a Tollgate 402 it checks the quote, pays through the hub, waits for a human if the payment needs approval, and retries with the receipt.

## Spending rules

Set per agent by its owner and enforced on the hub, so an agent can't get around them:

| Rule | Default | Effect |
|---|---|---|
| `maxPerRequest` | $1.00 | Never pay more than this for one request |
| `approvalAbove` | $0.25 | Payments above this wait for the owner to approve or deny |
| `dailyLimit` | $5.00 | Total spend per UTC day |
| `allowedHosts` | any | Only pay these hosts (`api.example.com`, `*.example.com`) |

Checks and the charge run in one database transaction, so 25 parallel requests can't sneak past a limit together.

## Security model

- **Receipts are signed** by the hub with Ed25519 (a standard JWS / JWT with `alg: EdDSA`). Sellers verify them **offline** with the hub's public key from `/.well-known/tollgate.json`. No network call per request.
- **Bound to one purchase**: each receipt names the seller, the exact resource (`GET /path?query`), the amount, and expires after 5 minutes. A $0.03 receipt can't unlock a $0.50 resource.
- **Single use**: sellers remember receipt ids, so a receipt can't be replayed. The store is pluggable for multi-server setups.
- **Agents check quotes**: the client refuses to pay through a hub that isn't its own, or for a URL on a different host than the one it requested.
- **Idempotent payments**: paying the same quote twice returns the same receipt and charges once.

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
apps/hub            wallets, ledger, spending rules, receipts, PayPal top-ups and payouts
packages/express    seller middleware: tollgate({ price }) for any Express route
packages/client     agent wallet: a fetch() that pays 402 responses automatically
packages/protocol   protocol types, receipt signing and verification, money helpers
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

Amounts in JSON are integer micros unless the field name ends in `Usd`.

**Agent endpoints** (`Authorization: Bearer <agent key>`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/pay` | Pay a seller's quote `{ quote, approvalId? }`. Returns a signed receipt, or `202` when approval is needed. |
| `GET` | `/v1/wallet` | Balance, today's spend and spending rules |
| `GET` | `/v1/approvals/:id` | Status of a pending approval |
| `GET` | `/.well-known/tollgate.json` | Hub's public keys for verifying receipts (no auth) |

**Admin endpoints** (`Authorization: Bearer <HUB_ADMIN_TOKEN>`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agents` | Create an agent wallet `{ name, policy? }`. Returns its API key once. |
| `PATCH` | `/api/agents/:id/policy` | Update spending limits |
| `POST` | `/api/agents/:id/topups` | Start a PayPal top-up `{ amountUsd }`. Returns the approval link. |
| `POST` | `/api/sellers` | Create a seller `{ name, paypalEmail }`. Returns its API key once. |
| `POST` | `/api/sellers/:id/payouts` | Pay out earnings via PayPal Payouts `{ amountUsd? }` |
| `POST` | `/api/payouts/:id/refresh` | Sync a payout's status with PayPal |
| `GET` | `/api/approvals` | Payments waiting for approval (`?status=pending`) |
| `POST` | `/api/approvals/:id/approve` | Approve a payment (`/deny` to deny) |
| `GET` | `/api/receipts` | Recent paid requests |
| `GET` | `/api/overview` | Agents, sellers, balances and ledger audit |
| `GET` | `/api/ledger/txns` | Recent ledger transactions |
| `GET` | `/api/ledger/audit` | Verify the ledger balances |
| `GET` | `/api/events` | Live event stream (Server-Sent Events) |
| `GET` | `/paypal/return` | Where PayPal sends the buyer after approving a top-up |

## License

[MIT](LICENSE)
