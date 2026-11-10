import { useState } from "react";
import type { Agent, Seller } from "./api";

/** Forms for creating an agent wallet or a seller, and the one-time key reveal. */

export type Created = { kind: "agent"; agent: Agent; apiKey: string } | { kind: "seller"; seller: Seller };

export function CreateAgent({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState("My research agent");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="db-card db-setup"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onCreate(name.trim() || "My agent").finally(() => setBusy(false));
      }}
    >
      <div className="db-setup-step">For AI agents</div>
      <h2 className="serif">Give an agent a wallet</h2>
      <p className="muted">
        It gets an API key to pay for data and APIs. You fund it with PayPal and set its limits: a daily budget, a max per request,
        and an amount above which it has to ask you first.
      </p>
      <label className="db-field">
        <span>Agent name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
      </label>
      <div className="db-setup-actions">
        <button type="submit" className="db-btn primary glow" disabled={busy}>{busy ? "Creating…" : "Create agent wallet"}</button>
        {onCancel && <button type="button" className="db-btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export function CreateSeller({ onCreate, onCancel }: { onCreate: (name: string, email: string) => Promise<void>; onCancel?: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="db-card db-setup"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onCreate(name.trim(), email.trim()).finally(() => setBusy(false));
      }}
    >
      <div className="db-setup-step">For API owners</div>
      <h2 className="serif">Get paid by agents</h2>
      <p className="muted">
        Register your API, add one line of middleware, and agents pay per request. Earnings collect here and cash out to your PayPal.
      </p>
      <label className="db-field">
        <span>API or site name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Market Data" maxLength={80} required />
      </label>
      <label className="db-field">
        <span>PayPal email for payouts</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
      </label>
      <div className="db-setup-actions">
        <button type="submit" className="db-btn primary glow" disabled={busy}>{busy ? "Registering…" : "Register as a seller"}</button>
        {onCancel && <button type="button" className="db-btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="db-btn soft small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          window.setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is selectable */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function Reveal({ created, hubUrl, onDone }: { created: Created; hubUrl: string; onDone: () => void }) {
  if (created.kind === "agent") {
    const code = `import { TollgateClient } from "@tollgate/client";

const wallet = new TollgateClient({
  hubUrl: "${hubUrl}",
  agentKey: process.env.TOLLGATE_AGENT_KEY,
});
const res = await wallet.fetch("https://api.example.com/data"); // pays if asked`;
    return (
      <section className="db-card db-setup" aria-live="polite">
        <div className="db-setup-step ok">Wallet ready</div>
        <h2 className="serif">{created.agent.name}</h2>
        <p className="muted">This is the agent's API key. Copy it now: for safety it's only shown once. You can make a new one later.</p>
        <div className="db-key"><span className="mono">{created.apiKey}</span><Copy text={created.apiKey} /></div>
        <pre className="mono db-code">{code}</pre>
        <p className="muted small">Using Claude Desktop? Put the key in the Tollgate MCP server's <span className="mono">TOLLGATE_AGENT_KEY</span>.</p>
        <div className="db-setup-actions">
          <button type="button" className="db-btn primary" onClick={onDone}>I saved it, open the wallet</button>
        </div>
      </section>
    );
  }
  const code = `import { tollgate } from "@tollgate/express";

app.get("/v1/data",
  tollgate({ hubUrl: "${hubUrl}", sellerId: "${created.seller.id}", price: "0.03" }),
  (req, res) => res.json(data));`;
  return (
    <section className="db-card db-setup" aria-live="polite">
      <div className="db-setup-step ok">Seller ready</div>
      <h2 className="serif">{created.seller.name}</h2>
      <p className="muted">Add this to any Express route. Agents without a receipt get a 402 with your price; paid requests go through.</p>
      <div className="db-key"><span className="mono">{created.seller.id}</span><Copy text={created.seller.id} /></div>
      <pre className="mono db-code">{code}</pre>
      <div className="db-setup-actions">
        <button type="button" className="db-btn primary" onClick={onDone}>Open my earnings</button>
      </div>
    </section>
  );
}
