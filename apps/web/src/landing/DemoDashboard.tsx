import { useEffect, useReducer, useRef, useState } from "react";
import { LogoMark } from "../Logo";
import "../dashboard/dashboard.css";

/**
 * A self-contained, simulated copy of the dashboard for the landing page.
 * Visitors can approve, deny, unblock a site, top up and cash out without signing in.
 * No network calls: everything runs in the browser with sample data.
 */

type Kind = "paid" | "asked" | "approved" | "denied" | "blocked" | "topup" | "payout";
interface Step { price: number; what: string; subject: string; seller: "Atlas Data" | "QuickLeads" }
interface Ev extends Partial<Step> { id: number; kind: Kind; amount: number; reason?: string }

const SCRIPT: Step[] = [
  { price: 0.02, what: "Company profile", subject: "NVIDIA", seller: "Atlas Data" },
  { price: 0.05, what: "Financials", subject: "NVIDIA", seller: "Atlas Data" },
  { price: 0.01, what: "News", subject: "NVIDIA", seller: "Atlas Data" },
  { price: 0.5, what: "Full report", subject: "NVIDIA", seller: "Atlas Data" },
  { price: 0.4, what: "Executive contacts", subject: "NVIDIA", seller: "QuickLeads" },
  { price: 0.02, what: "Company profile", subject: "Apple", seller: "Atlas Data" },
  { price: 0.05, what: "Financials", subject: "Microsoft", seller: "Atlas Data" },
];
const DAILY_LIMIT = 2;
const ASK_ABOVE = 0.25;
const FEE = 0.01;

interface State {
  balance: number;
  spent: number;
  earned: number;
  byItem: Record<string, number>;
  events: Ev[];
  pending: Step | null;
  idx: number;
  allowOnly: boolean;
  nextId: number;
}

const initial: State = { balance: 10, spent: 0, earned: 0.62, byItem: {}, events: [], pending: null, idx: 0, allowOnly: true, nextId: 1 };

type Action = { type: "tick" } | { type: "approve" } | { type: "deny" } | { type: "toggleSites" } | { type: "topup" } | { type: "payout" } | { type: "reset" };

function log(s: State, ev: Omit<Ev, "id">): Pick<State, "events" | "nextId"> {
  return { events: [{ ...ev, id: s.nextId }, ...s.events].slice(0, 6), nextId: s.nextId + 1 };
}

function pay(s: State, step: Step, kind: "paid" | "approved"): State {
  const net = step.price * (1 - FEE);
  return {
    ...s,
    ...log(s, { kind, amount: step.price, ...step }),
    balance: s.balance - step.price,
    spent: s.spent + step.price,
    earned: step.seller === "Atlas Data" ? s.earned + net : s.earned,
    byItem: step.seller === "Atlas Data" ? { ...s.byItem, [step.what]: (s.byItem[step.what] ?? 0) + net } : s.byItem,
  };
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "tick": {
      if (s.pending) return s;
      const step = SCRIPT[s.idx % SCRIPT.length];
      const next = { ...s, idx: s.idx + 1 };
      const block = (reason: string) => ({ ...next, ...log(s, { kind: "blocked" as const, amount: step.price, reason, ...step }) });
      if (step.seller === "QuickLeads" && s.allowOnly) return block("QuickLeads isn't on your allowed list");
      if (s.spent + step.price > DAILY_LIMIT) return block("Daily limit reached");
      if (step.price > s.balance) return block("Wallet is empty");
      if (step.price > ASK_ABOVE) return { ...next, pending: step, ...log(s, { kind: "asked", amount: step.price, ...step }) };
      return pay(next, step, "paid");
    }
    case "approve":
      return s.pending ? { ...pay(s, s.pending, "approved"), pending: null } : s;
    case "deny":
      return s.pending ? { ...s, pending: null, ...log(s, { kind: "denied", amount: s.pending.price, ...s.pending }) } : s;
    case "toggleSites":
      return { ...s, allowOnly: !s.allowOnly };
    case "topup":
      return { ...s, balance: s.balance + 10, ...log(s, { kind: "topup", amount: 10 }) };
    case "payout": {
      const amount = Math.floor(s.earned * 100) / 100;
      return amount >= 1 ? { ...s, earned: s.earned - amount, ...log(s, { kind: "payout", amount }) } : s;
    }
    case "reset":
      return initial;
  }
}

const money = (v: number, d = 2) => `$${v.toFixed(d)}`;
const RING = 2 * Math.PI * 70;

function describe(e: Ev, role: "owner" | "seller"): { text: string; sub: string; amount: string; tone: string } {
  const what = `${e.what?.toLowerCase()} · ${e.subject}`;
  switch (e.kind) {
    case "paid": return role === "owner"
      ? { tone: "pay", text: `Paid ${e.seller} for ${e.what?.toLowerCase()}`, sub: e.subject ?? "", amount: `−${money(e.amount)}` }
      : { tone: "pay", text: `Research Agent bought ${e.what?.toLowerCase()}`, sub: e.subject ?? "", amount: `+${money(e.amount * (1 - FEE), 4)}` };
    case "asked": return { tone: "wait", text: role === "owner" ? `Asked you to approve ${e.what?.toLowerCase()}` : `Waiting for the buyer to approve ${e.what?.toLowerCase()}`, sub: e.subject ?? "", amount: money(e.amount) };
    case "approved": return role === "owner"
      ? { tone: "pay", text: `You approved ${what}`, sub: e.seller ?? "", amount: `−${money(e.amount)}` }
      : { tone: "pay", text: `Sold ${e.what?.toLowerCase()} after approval`, sub: e.subject ?? "", amount: `+${money(e.amount * (1 - FEE), 4)}` };
    case "denied": return { tone: "stop", text: role === "owner" ? `You denied ${e.what?.toLowerCase()}` : `The buyer declined ${e.what?.toLowerCase()}`, sub: e.subject ?? "", amount: "—" };
    case "blocked": return { tone: "stop", text: `Stopped ${e.what?.toLowerCase()} from ${e.seller}`, sub: e.reason ?? "", amount: "—" };
    case "topup": return { tone: "money", text: "Added money from PayPal", sub: "PayPal Checkout (simulated)", amount: `+${money(e.amount)}` };
    case "payout": return { tone: "money", text: "Cashed out to PayPal", sub: "PayPal Payouts (simulated)", amount: money(e.amount) };
  }
}

export function DemoDashboard() {
  const [s, dispatch] = useReducer(reducer, initial);
  const [role, setRole] = useState<"owner" | "seller">("owner");
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Only run while the demo is on screen, so the story starts when the visitor gets there.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setVisible(true);
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || s.pending) return;
    const t = window.setTimeout(() => dispatch({ type: "tick" }), s.events.length === 0 ? 700 : 2200);
    return () => window.clearTimeout(t);
  }, [visible, s.pending, s.events.length, s.idx]);

  const frac = Math.min(1, s.spent / DAILY_LIMIT);
  const owner = role === "owner";
  const rows = s.events
    .filter((e) => owner || e.seller === "Atlas Data" || e.kind === "payout")
    .filter((e) => owner || e.kind !== "topup")
    .slice(0, 5);
  const items = Object.entries(s.byItem).sort((a, b) => b[1] - a[1]);
  const top = Math.max(0.01, ...items.map(([, v]) => v));
  const cashable = Math.floor(s.earned * 100) / 100;

  return (
    <section id="demo" data-tone="indigo" className="lb-section demo-section">
      <div className="wrap">
        <div className="demo-head rv">
          <div>
            <div className="kicker mono">INTERACTIVE DEMO</div>
            <h2 className="serif h2">Try it. <em>You're the owner.</em></h2>
          </div>
          <p className="lede">A demo agent is shopping for market data right now. Approve its big purchases, unblock a site, then switch to the seller and cash out.</p>
        </div>

        <div className="demo-frame rv2" ref={ref}>
          <div className="demo-bar">
            <div className="demo-dots" aria-hidden="true"><span /><span /><span /></div>
            <span className="mono demo-url">tollgate · dashboard</span>
            <div className="demo-bar-right">
              <div className="db-switch" role="group" aria-label="View the demo as">
                <button type="button" aria-pressed={owner} className={owner ? "on" : ""} onClick={() => setRole("owner")}>Owner</button>
                <button type="button" aria-pressed={!owner} className={!owner ? "on" : ""} onClick={() => setRole("seller")}>Seller</button>
              </div>
              <button type="button" className="db-btn ghost small" onClick={() => dispatch({ type: "reset" })}>Restart</button>
            </div>
          </div>

          <div className="demo-body">
            {owner ? (
              <div className="db-hero">
                <div className="wallet-card demo-wallet">
                  <div className="wallet-shine" aria-hidden="true" />
                  <div className="wallet-top"><span className="mono tracking">AGENT WALLET</span><span className="wallet-chip">PayPal-funded</span></div>
                  <div><div className="wallet-name">Research Agent</div><div className="serif wallet-balance">{money(s.balance)}</div></div>
                  <div className="wallet-bottom">
                    <span className="mono">agt_•••• 7Q2K</span>
                    <button type="button" className="wallet-add" onClick={() => dispatch({ type: "topup" })}>+ Add $10</button>
                  </div>
                </div>
                <div className="db-card ring-card demo-card">
                  <div className="ring">
                    <svg width="170" height="170" viewBox="0 0 170 170" role="img" aria-label={`Spent ${money(s.spent)} of ${money(DAILY_LIMIT)} today`}>
                      <circle cx="85" cy="85" r="70" fill="none" stroke="#EEEEF7" strokeWidth="16" />
                      <circle cx="85" cy="85" r="70" fill="none" stroke={frac > 0.8 ? "#DC2626" : "#4F46E5"} strokeWidth="16" strokeLinecap="round" strokeDasharray={`${RING * frac} ${RING}`} transform="rotate(-90 85 85)" className="ring-arc" />
                    </svg>
                    <div className="ring-label"><div className="serif">{money(s.spent)}</div><div className="muted small">of {money(DAILY_LIMIT)} today</div></div>
                  </div>
                  <div className="demo-rules">
                    <span className="chip">Ask me above $0.25</span>
                    <button type="button" className={`chip ${s.allowOnly ? "soft" : "warn"}`} onClick={() => dispatch({ type: "toggleSites" })} aria-pressed={s.allowOnly}>
                      {s.allowOnly ? "Only Atlas Data ✓" : "Any site"}
                    </button>
                  </div>
                </div>
                <div className="needs">
                  <div className="row-between"><span className="strong">Needs you</span><span className="muted small">{s.pending ? "1 waiting" : "0 waiting"}</span></div>
                  {s.pending ? (
                    <div className="notif-card demo-pending">
                      <div className="notif-card-head"><LogoMark size={32} className="notif-icon" /><div className="muted small">Research Agent · now</div></div>
                      <div className="notif-card-title">Spend {money(s.pending.price)} on {s.pending.what.toLowerCase()}?</div>
                      <div className="muted small">{s.pending.subject} · {s.pending.seller} · over your $0.25 limit</div>
                      <div className="notif-card-actions">
                        <button type="button" className="db-btn primary" onClick={() => dispatch({ type: "approve" })}>Approve</button>
                        <button type="button" className="db-btn soft" onClick={() => dispatch({ type: "deny" })}>Deny</button>
                      </div>
                      <div className="demo-yourturn mono">YOUR TURN</div>
                    </div>
                  ) : (
                    <div className="needs-empty">Nothing waiting. Big purchases will pop up here for you to approve.</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="db-hero seller">
                <div className="cheque">
                  <div className="cheque-lines" aria-hidden="true" />
                  <div className="cheque-body">
                    <div className="cheque-top mono"><span>PAY TO THE ORDER OF</span><span>SAMPLE DATA</span></div>
                    <div className="serif cheque-name">Atlas Data</div>
                    <div className="cheque-row">
                      <div><div className="muted small">Available, after the 1% fee</div><div className="serif cheque-amount">${s.earned.toFixed(4)}</div></div>
                      <button type="button" className={`db-btn ${cashable >= 1 ? "primary glow" : "soft"}`} disabled={cashable < 1} onClick={() => dispatch({ type: "payout" })}>
                        {cashable >= 1 ? `Cash out ${money(cashable)} via PayPal` : "Cash out from $1.00"}
                      </button>
                    </div>
                    <div className="muted small cheque-note">{cashable >= 1
                        ? "Ready. One PayPal payout sends everything agents paid you."
                        : s.events.some((e) => e.kind === "payout")
                          ? "Cashed out. New sales keep adding up here."
                          : `${money(1 - s.earned, 4)} to go. Approve the agent's full report to get there.`}</div>
                  </div>
                </div>
                <div className="db-card earned demo-card">
                  <div className="strong">Earned by item</div>
                  <div className="earned-list">
                    {items.length === 0 && <div className="muted small">Sales appear here as the agent buys.</div>}
                    {items.map(([label, v]) => (
                      <div key={label}>
                        <div className="row-between small"><span>{label}</span><span className="mono">${v.toFixed(4)}</span></div>
                        <div className="bar-track"><div className="bar-fill" style={{ width: `${(v / top) * 100}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="db-card timeline demo-card">
              <div className="row-between"><span className="strong">Timeline</span><span className="muted small">{visible ? "live" : "paused"}</span></div>
              {rows.length === 0 ? (
                <div className="muted small timeline-empty">The agent is about to make its first purchase…</div>
              ) : (
                <ol className="tl">
                  {rows.map((e) => {
                    const r = describe(e, role);
                    return (
                      <li key={e.id} className={`tl-row ${r.tone}`}>
                        <span className="tl-dot" aria-hidden="true" />
                        <div className="tl-main"><div>{r.text}</div><div className="muted small">{r.sub}</div></div>
                        <div className="mono tl-amount">{r.amount}</div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        </div>

        <p className="demo-note muted small rv3">Interactive demo with sample data. It runs in your browser and no real money moves. <a href="/app?signup">Try the live version with real PayPal sandbox →</a></p>
      </div>
    </section>
  );
}
