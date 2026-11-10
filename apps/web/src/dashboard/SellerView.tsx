import { usd, type Overview, type Payout, type Seller, type Txn } from "./api";
import { timeAgo } from "./OwnerView";

interface Props {
  overview: Overview;
  seller: Seller;
  onPickSeller: (id: string) => void;
  payouts: Payout[];
  txns: Txn[];
  onPayout: () => void;
}


export function SellerView({ overview, seller, onPickSeller, payouts, txns, onPayout }: Props) {
  // Earnings by item, from this seller's side of each charge in the ledger.
  const byItem = new Map<string, number>();
  let requests = 0;
  for (const t of txns) {
    if (t.type !== "charge") continue;
    const mine = t.entries.find((e) => e.accountId === seller.accountId)?.amount ?? 0;
    const desc = String(t.meta?.description ?? t.meta?.resource ?? "Other");
    const label = desc.split(":")[0].trim();
    byItem.set(label, (byItem.get(label) ?? 0) + mine);
    requests++;
  }
  const items = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const top = Math.max(1, ...items.map(([, v]) => v));
  const MIN_PAYOUT = overview.minPayout ?? 1_000_000;
  const canPay = seller.balance >= MIN_PAYOUT && !!seller.paypalEmail;
  const reason = !seller.paypalEmail ? "Add a PayPal email to this seller to cash out" : seller.balance < MIN_PAYOUT ? `Cash out from ${usd(MIN_PAYOUT, 2)} · ${usd(MIN_PAYOUT - seller.balance)} to go` : "";

  return (
    <div className="db-hero seller">
      <div className="cheque">
        <div className="cheque-lines" aria-hidden="true" />
        <div className="cheque-body">
          <div className="cheque-top mono">
            <span>PAY TO THE ORDER OF</span>
            <span>{new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}</span>
          </div>
          {overview.sellers.length > 1 ? (
            <select className="serif cheque-select" aria-label="Seller" value={seller.id} onChange={(e) => onPickSeller(e.target.value)}>
              {overview.sellers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          ) : (
            <div className="serif cheque-name">{seller.name}</div>
          )}
          <div className="cheque-row">
            <div>
              <div className="muted small">Available, after the {overview.feeBps / 100}% fee</div>
              <div className="serif cheque-amount">{usd(seller.balance)}</div>
            </div>
            <button type="button" className={`db-btn ${canPay ? "primary glow" : "soft"}`} disabled={!canPay} onClick={onPayout}>Cash out via PayPal</button>
          </div>
          <div className="muted small cheque-note">
            {reason || `Sent to ${seller.paypalEmail} through PayPal Payouts. If PayPal rejects it, the money comes back to this balance.`}
          </div>
        </div>
      </div>

      <div className="db-card earned" id="rules">
        <div className="row-between"><span className="strong">Earned by item</span><span className="muted small">{requests} paid requests</span></div>
        <div className="earned-list">
          {items.length === 0 && <div className="muted small">No paid requests yet. Earnings show up here as agents pay you.</div>}
          {items.map(([label, value]) => (
            <div key={label}>
              <div className="row-between small"><span>{label}</span><span className="mono">{usd(value)}</span></div>
              <div className="bar-track"><div className="bar-fill" style={{ width: `${(value / top) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div className="db-card payouts">
        <div className="strong">Payouts</div>
        {payouts.length === 0 && <div className="muted small payouts-empty">No payouts yet.</div>}
        {payouts.slice(0, 5).map((p) => (
          <div key={p.id} className="payout-row">
            <div>
              <div className="mono">{usd(p.amount, 2)}</div>
              <div className="muted small">{timeAgo(p.createdAt)}{p.error ? ` · ${p.error}` : ""}</div>
            </div>
            <span className={`status ${p.status}`}>{p.status === "processing" ? "Processing" : p.status === "paid" ? "Paid" : p.status === "unclaimed" ? "Unclaimed" : "Failed, refunded"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
