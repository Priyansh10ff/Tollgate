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

## Requirements

- Node.js 22.13 or newer
- A PayPal developer account (sandbox)
- A Claude API key (for the demo agent)

## Setup

```bash
npm install
cp .env.example .env      # then fill in your keys
npm run check-setup       # verifies Node, PayPal and Claude settings
```

## License

[MIT](LICENSE)
