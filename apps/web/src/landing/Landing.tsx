import { useState } from "react";
import { Hero, HERO_SCROLL, BOOT_LINES } from "./Hero";
import { DemoDashboard } from "./DemoDashboard";
import { useBoot, useScroll, clamp } from "./useScroll";
import "./landing.css";

const TONES: Record<string, [string, string, string]> = {
  indigo: ["#DCDDFE", "#ECE9FF", "#E4F1FB"],
  rose: ["#FCDDE6", "#EDEAFF", "#FFF1F4"],
  mint: ["#D3F5E6", "#E6E8FF", "#ECFAF3"],
};

const STUBS: [number, number, number, string, number][] = [
  [6, 78, -8, "$0.02 · profile", 0.3],
  [86, 12, 7, "$0.05 · financials", 0.5],
  [90, 70, -5, "rcpt_x8k ✓", 0.22],
  [3, 30, 6, "200 OK", 0.42],
  [72, 88, 4, "$0.0015", 0.36],
  [44, 4, -3, "EdDSA ✓", 0.27],
];

const SNIPPETS = [
  { tab: "Seller", file: "server.ts", code: 'import { tollgate } from "@tollgate/express";\n\napp.get("/v1/report",\n  tollgate({ hubUrl, sellerId, price: "0.03" }),\n  (req, res) => res.json(report));' },
  { tab: "Agent", file: "agent.ts", code: 'import { TollgateClient } from "@tollgate/client";\n\nconst tollgate = new TollgateClient({ hubUrl, agentKey });\nconst res = await tollgate.fetch(url); // pays the 402 for you' },
  { tab: "Claude Desktop", file: "claude_desktop_config.json", code: '{\n  "mcpServers": {\n    "tollgate": { "command": "node", "args": ["tollgate/packages/mcp/src/server.ts"] }\n  }\n}' },
];

const FAQS = [
  { q: "Do agents need their own PayPal account?", a: "No. The owner tops up the agent’s wallet once through PayPal Checkout. The agent pays from that balance with an API key." },
  { q: "How do sub-cent prices work?", a: "Charges are recorded in a double-entry ledger in micro-dollars. PayPal is only used for top-ups and seller payouts." },
  { q: "Can an agent overspend?", a: "No. Daily limits, per-request caps, allowed sites and approvals are enforced on the hub, inside the same database transaction as the charge." },
  { q: "What if a payout fails?", a: "Funds are reserved before PayPal is called. If PayPal rejects the payout, a reversal returns the money to the seller exactly once." },
  { q: "Does it work with Claude?", a: "Yes. The Tollgate MCP server gives Claude Desktop and other MCP clients a wallet with the same rules." },
];

export function Landing() {
  const { top, vh, vw, tone: sectionTone } = useScroll();
  const boot = useBoot(BOOT_LINES, 220);
  const [tab, setTab] = useState(0);

  const p = clamp(top / HERO_SCROLL);
  const heroTone = p < 0.02 ? "rose" : p > 0.8 ? "mint" : "indigo";
  const [c1, c2, c3] = TONES[sectionTone === "hero" ? heroTone : sectionTone] ?? TONES.indigo;
  const blob = (left: number, topPct: number, size: number, color: string, k: number) => ({
    left: `${left}%`, top: `${topPct}%`, width: `${size}vmax`, height: `${size}vmax`, background: color, transform: `translateY(${-top * k}px)`,
  });

  return (
    <div className="lb">
      <div className="lb-bg" aria-hidden="true">
        <div className="lb-blob" style={blob(-10, -14, 56, c1, 0.02)} />
        <div className="lb-blob" style={blob(56, 18, 50, c2, 0.035)} />
        <div className="lb-blob" style={blob(18, 64, 44, c3, 0.015)} />
        <div className="lb-dots" style={{ transform: `translateY(${-((top * 0.18) % 26)}px)` }} />
        {STUBS.map(([left, topPct, rot, text, k], i) => (
          <div key={text} className="lb-stub-wrap" style={{ left: `${left}%`, top: `${topPct}%`, transform: `translateY(${-(top * k) % 2200}px)`, opacity: top < 200 ? 0.3 : 0.5 }}>
            <div className="lb-stub mono" style={{ ["--r" as string]: `${rot}deg`, animationDelay: `${i * 0.7}s` }}>{text}</div>
          </div>
        ))}
        <svg className="lb-grain" width="100%" height="100%">
          <filter id="lb-noise"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves={2} stitchTiles="stitch" /></filter>
          <rect width="100%" height="100%" filter="url(#lb-noise)" />
        </svg>
      </div>

      <nav className="lb-nav">
        <a href="/" className="serif lb-logo">Tollgate<span>.</span></a>
        <div className="lb-nav-links">
          <a href="#demo">Try the demo</a>
          <a href="#how">How it works</a>
          <a href="#code">Developers</a>
          <a href="#pricing">Pricing</a>
          <a href="/app" className="lb-nav-cta">Open dashboard</a>
        </div>
      </nav>

      <main>
        <Hero top={top} vh={vh} vw={vw} boot={boot} />

        <DemoDashboard />

        <section id="how" data-tone="indigo" className="lb-section">
          <div className="wrap">
            <h2 className="serif h2 rv">Three steps between an agent and the data it needs.</h2>
            <div className="steps">
              <div className="steps-line draw" />
              {[
                ["The API asks for money", <>One line of middleware answers <span className="mono ink">402 Payment Required</span> with a price and a quote.</>],
                ["The wallet pays, within the rules", "The hub checks the owner's limits, charges the PayPal-funded wallet and signs a receipt."],
                ["The seller verifies and serves", "Receipt checked offline, data delivered, earnings paid out through PayPal."],
              ].map(([title, body], i) => (
                <div key={i} className={`step rv${i ? i + 1 : ""}`}>
                  <div className="step-num serif">{i + 1}</div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section data-tone="rose" className="lb-section">
          <div className="wrap split align-end">
            <div className="rv">
              <div className="kicker mono rose">WHY NOBODY DOES THIS TODAY</div>
              <h2 className="serif h2">The fee is the problem, <em>not the price.</em></h2>
              <p className="lede">An API call is worth fractions of a cent. A card transaction typically costs around 30¢ in fixed fees. Tollgate records the tiny charges in a ledger and only touches PayPal to top up and pay out.</p>
            </div>
            <div className="bars rv2">
              <div className="bar-col"><div className="mono">$0.0015</div><div className="bar grow" style={{ height: 2, background: "var(--indigo)" }} /><div className="bar-label">one API call</div></div>
              <div className="bar-col"><div className="mono rose">≈ $0.30</div><div className="bar grow" style={{ height: 240, background: "#F43F5E", borderRadius: "10px 10px 0 0" }} /><div className="bar-label">typical card fee</div></div>
            </div>
          </div>
        </section>

        <section data-tone="mint" className="lb-section">
          <div className="wrap stack-xl">
            <div className="split">
              <div className="rv">
                <div className="kicker mono">FOR SELLERS</div>
                <h3 className="serif h3">Turn agent traffic into revenue.</h3>
                <p className="lede">Price each endpoint, from $0.000001. Receipts verify offline. Withdraw everything in one PayPal payout.</p>
              </div>
              <div className="card rv2">
                <div className="row-between"><span className="muted small">Atlas Data · earned this week</span><span className="mint small strong">PayPal payout ready</span></div>
                <div className="serif big-num">$2.97</div>
                <svg viewBox="0 0 400 90" width="100%" height="90" aria-hidden="true">
                  <path d="M0,80 C40,78 60,70 90,66 C130,60 150,64 180,50 C220,32 250,40 280,28 C320,14 350,18 400,6 L400,90 L0,90 Z" fill="#EEF0FF" />
                  <path d="M0,80 C40,78 60,70 90,66 C130,60 150,64 180,50 C220,32 250,40 280,28 C320,14 350,18 400,6" fill="none" stroke="#4F46E5" strokeWidth={2.5} />
                </svg>
                <div className="price-list mono">
                  <div><span>GET /v1/companies/:slug</span><span>$0.02</span></div>
                  <div><span>GET /v1/companies/:slug/financials</span><span>$0.05</span></div>
                  <div><span>GET /v1/reports/:slug</span><span>$0.50</span></div>
                </div>
              </div>
            </div>
            <div className="split reverse">
              <div className="phone-wrap rv2">
                <div className="phone">
                  <div className="phone-screen">
                    <div className="phone-time">9:41</div>
                    <div className="notif">
                      <div className="notif-head"><div className="notif-icon serif">T</div><div className="small strong">Tollgate · now</div></div>
                      <div className="notif-title">Research Agent wants to spend $0.50</div>
                      <div className="small muted">Analyst report · Northwind Robotics · Atlas Data</div>
                      <div className="notif-actions"><span className="na-approve">Approve</span><span className="na-deny">Deny</span></div>
                    </div>
                    <div className="notif-muted">Blocked: QuickLeads isn't on the allowed list</div>
                  </div>
                </div>
              </div>
              <div className="rv">
                <div className="kicker mono">FOR OWNERS</div>
                <h3 className="serif h3">Your agent spends. <em>You decide.</em></h3>
                <p className="lede">Daily limits, a per-request cap, an allowed list, and a tap to approve anything big. Enforced by the hub, so an agent can't argue its way around them.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="code" data-tone="indigo" className="lb-section center">
          <div className="wrap narrow">
            <h2 className="serif h2 rv">Three packages. <em>One afternoon.</em></h2>
            <div className="tabs rv" role="tablist" aria-label="Code examples">
              {SNIPPETS.map((s, i) => (
                <button key={s.tab} type="button" role="tab" aria-selected={tab === i} className={tab === i ? "on" : ""} onClick={() => setTab(i)}>{s.tab}</button>
              ))}
            </div>
            <div className="code-card rv2">
              <div className="mono small muted">{SNIPPETS[tab].file}</div>
              <pre className="mono">{SNIPPETS[tab].code}</pre>
            </div>
          </div>
        </section>

        <section data-tone="mint" className="lb-section">
          <div className="wrap split">
            <div className="rv">
              <div className="kicker mono">TRUST</div>
              <h2 className="serif h2">Every receipt is signed. <em>Every cent is counted.</em></h2>
              <ul className="checks">
                <li>Ed25519 signatures. Change one byte and it fails.</li>
                <li>Bound to one seller, one URL, one price. Valid once, for 5 minutes.</li>
                <li>Double-entry ledger in micro-dollars. Audited on demand.</li>
                <li>Payouts are reserved first and reversed exactly once if PayPal rejects them.</li>
              </ul>
            </div>
            <div className="card audit mono rv2">
              <div className="small muted tracking">LEDGER AUDIT · OK</div>
              <div><span>Topped up via PayPal</span><span>$10.00</span></div>
              <div className="muted"><span>In the agent's wallet</span><span>$7.00</span></div>
              <div className="muted"><span>Paid out to Atlas Data</span><span>$2.97</span></div>
              <div className="muted"><span>Tollgate fees</span><span>$0.03</span></div>
              <div className="audit-total"><span>Difference</span><span className="mint">$0.000000 ✓</span></div>
            </div>
          </div>
        </section>

        <section data-tone="indigo" className="lb-section">
          <div className="wrap mcp rv">
            <div>
              <div className="kicker mono light">MODEL CONTEXT PROTOCOL</div>
              <h2 className="serif h2">Give Claude a wallet.</h2>
              <p className="lede light">Add the Tollgate MCP server and any MCP client can call paid APIs, with your limits and approvals.</p>
            </div>
            <div className="chat">
              <div className="bubble me">Get Helios Grid's latest financials.</div>
              <div className="bubble them"><div className="mono small light">tollgate_fetch · paid $0.05</div><div>Helios Grid made $310M revenue in 2025, up 22%, with $210M of debt.</div></div>
            </div>
          </div>
        </section>

        <section id="pricing" data-tone="indigo" className="lb-section tight-top">
          <div className="wrap pricing">
            <div className="card plan rv">
              <div className="strong">Self-hosted</div>
              <div className="serif plan-price">Free</div>
              <p className="muted">MIT licensed. Run your own hub with your own PayPal app.</p>
            </div>
            <div className="card plan featured rv2">
              <div className="strong indigo">Hosted hub</div>
              <div className="serif plan-price">1%</div>
              <p className="muted">of each paid request. No monthly fee. PayPal's standard fees apply to top-ups and payouts.</p>
            </div>
          </div>
        </section>

        <section data-tone="indigo" className="lb-section tight-top">
          <div className="wrap faq">
            <h2 className="serif h2 rv">Questions</h2>
            <div className="faq-list">
              {FAQS.map((f) => (
                <details key={f.q} className="rv">
                  <summary>{f.q}<span aria-hidden="true">+</span></summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section data-tone="mint" className="lb-section final">
          <h2 className="serif rv">Every request,<br /><em>paid for.</em></h2>
          <div className="hero-cta center rv2">
            <a className="btn-primary" href="/app">Start charging agents</a>
            <a className="btn-white" href="#how">Read the protocol</a>
          </div>
        </section>
      </main>

      <footer className="lb-footer">
        <span>Tollgate · MIT licensed · Built for the PayPal AI Hackathon</span>
        <span>Settled through PayPal</span>
      </footer>
    </div>
  );
}
