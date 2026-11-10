import { usd, type HubEvent } from "./api";
import { shortUrl, timeAgo } from "./OwnerView";

interface Row { id: number; at: string; tone: "pay" | "stop" | "wait" | "money"; text: string; sub: string; amount: string }

/** Turns hub events into plain-English rows for the owner or the seller. */
function describe(e: HubEvent, role: "owner" | "seller"): Omit<Row, "id" | "at"> | null {
  const d = e.data;
  const what = d.description ?? (d.url ? shortUrl(d.url) : "a request");
  switch (e.type) {
    case "charge.completed":
      return role === "owner"
        ? { tone: "pay", text: `Paid ${d.sellerName} for ${what}`, sub: d.host ?? "", amount: `−${usd(d.price)}` }
        : { tone: "pay", text: `${d.agentName} bought ${what}`, sub: `receipt ${d.receiptId ?? ""}`, amount: `+${usd(d.price - d.fee)}` };
    case "payment.declined":
      return role === "owner"
        ? { tone: "stop", text: `Stopped ${what} from ${d.sellerName}`, sub: d.reason, amount: "—" }
        : { tone: "stop", text: `${d.agentName} couldn't buy ${what}`, sub: "The buyer's rules stopped it", amount: "—" };
    case "approval.requested":
      return { tone: "wait", text: role === "owner" ? `Asked you to approve ${what}` : `${d.agentName} is waiting for approval to buy ${what}`, sub: d.reason ?? "", amount: usd(d.amount) };
    case "approval.approved":
      return { tone: "pay", text: role === "owner" ? "You approved a payment" : "The buyer approved your sale", sub: d.url ? shortUrl(d.url) : "", amount: usd(d.amount) };
    case "approval.denied":
      return { tone: "stop", text: role === "owner" ? "You denied a payment" : "The buyer declined your sale", sub: d.url ? shortUrl(d.url) : "", amount: "—" };
    case "topup.created":
      return { tone: "wait", text: "Top-up started", sub: "Waiting for PayPal checkout", amount: usd(d.amount, 2) };
    case "topup.completed":
      return { tone: "money", text: "Added money from PayPal", sub: `New balance ${usd(d.balance, 2)}`, amount: `+${usd(d.amount, 2)}` };
    case "payout.created":
      return { tone: "wait", text: "Payout sent to PayPal", sub: "Processing", amount: usd(d.amount, 2) };
    case "payout.paid":
      return { tone: "money", text: "Payout arrived in PayPal", sub: "PayPal Payouts", amount: usd(d.amount, 2) };
    case "payout.unclaimed":
      return { tone: "money", text: "Payout sent, not yet claimed", sub: "The PayPal account needs to accept it", amount: usd(d.amount, 2) };
    case "payout.failed":
      return { tone: "stop", text: "Payout failed, money returned", sub: d.error ?? "", amount: usd(d.amount, 2) };
    default:
      return null;
  }
}

export function Timeline({ events, role, agentId, sellerId }: { events: HubEvent[]; role: "owner" | "seller"; agentId?: string; sellerId?: string }) {
  const relevant = events.filter((e) => {
    if (role === "owner") return e.data.agentId === agentId;
    if (e.type.startsWith("topup.") || e.type.startsWith("approval.approved") || e.type.startsWith("approval.denied")) return false;
    return e.data.sellerId === sellerId;
  });
  const rows: Row[] = relevant
    .map((e) => {
      const r = describe(e, role);
      return r && { ...r, id: e.id, at: e.at };
    })
    .filter((r): r is Row => !!r)
    .slice(0, 20);

  return (
    <section id="timeline" className="db-card timeline">
      <div className="row-between">
        <h2 className="db-h2">Timeline</h2>
        <span className="muted small">Live from the hub</span>
      </div>
      {rows.length === 0 ? (
        <div className="muted small timeline-empty">
          Nothing yet. Start the demo with <span className="mono">npm run dev</span> and <span className="mono">npm run agent</span>, and payments will appear here as they happen.
        </div>
      ) : (
        <ol className="tl">
          {rows.map((r) => (
            <li key={r.id} className={`tl-row ${r.tone}`}>
              <span className="tl-dot" aria-hidden="true" />
              <div className="tl-main">
                <div>{r.text}</div>
                <div className="muted small">{[r.sub, timeAgo(r.at)].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="mono tl-amount">{r.amount}</div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
