import { useEffect, useState } from "react";
import { LogoMark } from "../Logo";
import { usd, type Agent, type Approval, type HubEvent, type Overview } from "./api";

type PolicyPatch = Partial<{ dailyLimitUsd: string; maxPerRequestUsd: string; approvalAboveUsd: string; allowedHosts: string[] }>;

interface Props {
  overview: Overview;
  agent: Agent;
  onPickAgent: (id: string) => void;
  pending: Approval[];
  events: HubEvent[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  onTopUp: () => void;
  onSavePolicy: (patch: PolicyPatch) => void;
}

const RING = 2 * Math.PI * 70;

export function OwnerView({ overview, agent, onPickAgent, pending, events, onApprove, onDeny, onTopUp, onSavePolicy }: Props) {
  const { policy } = agent;
  const frac = Math.min(1, agent.spentToday / Math.max(1, policy.dailyLimit));
  const sellerName = (id: string) => overview.sellers.find((s) => s.id === id)?.name ?? "a seller";
  const today = new Date().toISOString().slice(0, 10);
  const mine = events.filter((e) => e.data.agentId === agent.id && e.at.startsWith(today));
  const paid = mine.filter((e) => e.type === "charge.completed").length;
  const blocked = mine.filter((e) => e.type === "payment.declined").length;
  const decided = events.filter((e) => (e.type === "approval.approved" || e.type === "approval.denied") && e.data.agentId === agent.id).slice(0, 3);

  return (
    <>
      <div className="db-hero">
        <div className="wallet-card">
          <div className="wallet-shine" aria-hidden="true" />
          <div className="wallet-top">
            <span className="mono tracking">AGENT WALLET</span>
            {overview.agents.length > 1 ? (
              <select aria-label="Agent" value={agent.id} onChange={(e) => onPickAgent(e.target.value)}>
                {overview.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            ) : (
              <span className="wallet-chip">PayPal-funded</span>
            )}
          </div>
          <div>
            <div className="wallet-name">{agent.name}</div>
            <div className="serif wallet-balance">{usd(agent.balance, 2)}</div>
          </div>
          <div className="wallet-bottom">
            <span className="mono">{agent.id.slice(0, 4)}•••• {agent.id.slice(-4)}</span>
            <button type="button" className="wallet-add" onClick={onTopUp}>+ Add $10 with PayPal</button>
          </div>
        </div>

        <div className="db-card ring-card">
          <div className="ring">
            <svg width="170" height="170" viewBox="0 0 170 170" role="img" aria-label={`Spent ${usd(agent.spentToday, 2)} of ${usd(policy.dailyLimit, 2)} today`}>
              <circle cx="85" cy="85" r="70" fill="none" stroke="#EEEEF7" strokeWidth="16" />
              <circle cx="85" cy="85" r="70" fill="none" stroke={frac > 0.8 ? "#DC2626" : "#4F46E5"} strokeWidth="16" strokeLinecap="round" strokeDasharray={`${RING * frac} ${RING}`} transform="rotate(-90 85 85)" className="ring-arc" />
            </svg>
            <div className="ring-label">
              <div className="serif">{usd(agent.spentToday, 2)}</div>
              <div className="muted small">of {usd(policy.dailyLimit, 2)} today</div>
            </div>
          </div>
          <div className="muted small">{paid} paid · <span className="red">{blocked} blocked</span> <span className="faint">(since the hub started)</span></div>
        </div>

        <div className="needs">
          <div className="row-between"><span className="strong">Needs you</span><span className="muted small">{pending.length} waiting</span></div>
          {pending.map((a) => (
            <div key={a.id} className="notif-card">
              <div className="notif-card-head"><LogoMark size={28} className="notif-icon" /><div className="muted small">{agent.name} · {timeAgo(a.createdAt)}</div></div>
              <div className="notif-card-title">Spend {usd(a.amount)} on {a.description ?? new URL(a.url).pathname}?</div>
              <div className="muted small">{sellerName(a.sellerId)} · over your {usd(policy.approvalAbove, 2)} ask-me limit</div>
              <div className="notif-card-actions">
                <button type="button" className="db-btn primary" onClick={() => onApprove(a.id)}>Approve</button>
                <button type="button" className="db-btn soft" onClick={() => onDeny(a.id)}>Deny</button>
              </div>
            </div>
          ))}
          {pending.length === 0 && <div className="needs-empty">Nothing waiting. Payments over {usd(policy.approvalAbove, 2)} will show up here.</div>}
          {decided.map((e) => (
            <div key={e.id} className="decided">
              <span>{usd(e.data.amount)} · {shortUrl(e.data.url)}</span>
              <span className={e.type === "approval.approved" ? "indigo strong" : "red strong"}>{e.type === "approval.approved" ? "Approved" : "Denied"}</span>
            </div>
          ))}
        </div>
      </div>

      <Rules key={agent.id} policy={policy} onSave={onSavePolicy} />
    </>
  );
}

type Editing = null | "daily" | "max" | "ask" | "sites";

function Rules({ policy, onSave }: { policy: Agent["policy"]; onSave: (patch: PolicyPatch) => void }) {
  const [editing, setEditing] = useState<Editing>(null);
  const [daily, setDaily] = useState(policy.dailyLimit / 1e6);
  const [max, setMax] = useState(policy.maxPerRequest / 1e6);
  const [ask, setAsk] = useState(policy.approvalAbove / 1e6);
  const [sites, setSites] = useState(policy.allowedHosts.join(", "));

  useEffect(() => {
    setDaily(policy.dailyLimit / 1e6);
    setMax(policy.maxPerRequest / 1e6);
    setAsk(policy.approvalAbove / 1e6);
    setSites(policy.allowedHosts.join(", "));
  }, [policy.dailyLimit, policy.maxPerRequest, policy.approvalAbove, policy.allowedHosts.join(",")]);

  const toggle = (e: Editing) => setEditing((cur) => (cur === e ? null : e));
  const save = () => {
    onSave({
      dailyLimitUsd: daily.toFixed(2),
      maxPerRequestUsd: max.toFixed(2),
      approvalAboveUsd: ask.toFixed(2),
      allowedHosts: sites.split(",").map((s) => s.trim()).filter(Boolean),
    });
    setEditing(null);
  };

  return (
    <section id="rules" className="db-card rules">
      <div className="rules-chips">
        <span className="strong">Rules</span>
        <button type="button" className={`chip ${editing === "daily" ? "on" : ""}`} onClick={() => toggle("daily")}>Daily limit · {usd(policy.dailyLimit, 2)}</button>
        <button type="button" className={`chip ${editing === "max" ? "on" : ""}`} onClick={() => toggle("max")}>Max per request · {usd(policy.maxPerRequest, 2)}</button>
        <button type="button" className={`chip ${editing === "ask" ? "on" : ""}`} onClick={() => toggle("ask")}>Ask me above · {usd(policy.approvalAbove, 2)}</button>
        <button type="button" className={`chip ${editing === "sites" ? "on" : policy.allowedHosts.length ? "soft" : "warn"}`} onClick={() => toggle("sites")}>
          {policy.allowedHosts.length ? `Only ${policy.allowedHosts.join(", ")}` : "Any site"}
        </button>
      </div>
      {editing && (
        <div className="rules-edit">
          {editing === "daily" && <Slider label="Daily limit" value={daily} min={0.5} max={20} step={0.5} onChange={setDaily} />}
          {editing === "max" && <Slider label="Max per request" value={max} min={0.01} max={5} step={0.01} onChange={setMax} />}
          {editing === "ask" && <Slider label="Ask me before paying more than" value={ask} min={0} max={2} step={0.05} onChange={setAsk} />}
          {editing === "sites" && (
            <label className="db-field">
              <span>Allowed sites (comma separated, e.g. localhost, *.example.com). Leave empty to allow any site.</span>
              <input value={sites} onChange={(e) => setSites(e.target.value)} placeholder="Any site" />
            </label>
          )}
          <div className="rules-actions">
            <button type="button" className="db-btn soft" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="db-btn primary" onClick={save}>Save rule</button>
          </div>
        </div>
      )}
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <label className="db-slider">
      <span className="row-between"><span>{label}</span><b className="mono">${value.toFixed(2)}</b></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}


