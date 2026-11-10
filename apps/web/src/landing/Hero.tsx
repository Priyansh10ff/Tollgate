import { clamp } from "./useScroll";

/** How far (px) the hero story scrolls before the page moves on. */
export const HERO_SCROLL = 3000;

type Row = { kind: "row"; label: string; value: string; tone?: "red" | "green" };
type Line = Row | { kind: "rule" } | { kind: "total" };
const R = (label: string, value: string, tone?: "red" | "green"): Row => ({ kind: "row", label, value, tone });
const RULE: Line = { kind: "rule" };
const LINE_H = { row: 30, rule: 30, total: 60 } as const;

/** The receipt, line by line. The first five print on load, then it jams at 402 until you scroll. */
const LINES: Line[] = [
  R("AGENT", "Research Agent"),
  R("REQUEST", "GET /v1/companies/northwind"),
  R("SELLER", "Atlas Data"),
  R("PRICE", "$0.03"),
  R("STATUS", "402 PAYMENT REQUIRED", "red"),
  RULE,
  R("RULE · PER REQUEST", "$0.03 ≤ $1.00 ✓"),
  R("RULE · DAILY LIMIT", "$0.61 of $2.00 ✓"),
  R("RULE · ALLOWED SITE", "atlas-data ✓"),
  R("WALLET", "$10.00 → $9.97"),
  RULE,
  R("RECEIPT", "rcpt_8Kq2xVfL"),
  R("SIGNATURE", "Ed25519 ✓"),
  R("VALID", "ONCE · 5 MIN"),
  R("STATUS", "200 OK", "green"),
  RULE,
  R("SELLER GETS", "$0.0297"),
  R("TOLLGATE FEE", "$0.0003"),
  R("SETTLES VIA", "PAYPAL PAYOUTS"),
  RULE,
  { kind: "total" },
];
export const BOOT_LINES = 5;

const CHAPTERS = [
  {
    kicker: "PAY-PER-REQUEST FOR AI AGENTS",
    title: "Every API call deserves a receipt.",
    body: "Tollgate lets AI agents pay for each request they make, in fractions of a cent, from a PayPal-funded wallet their owner controls.",
    cta: true,
  },
  { kicker: "FIG. 1 · THE RULES", title: "Rules first. Money second.", body: "Before a cent moves, the hub checks the owner’s per-request cap, daily limit and allowed sites." },
  { kicker: "FIG. 2 · THE SEAL", title: "Signed, sealed, single use.", body: "An Ed25519 receipt only this seller, this URL and this price can accept. Verified offline." },
  { kicker: "FIG. 3 · THE SPLIT", title: "Counted to the micro-dollar.", body: "The seller gets $0.0297, Tollgate keeps $0.0003, and the ledger balances to zero." },
  { kicker: "FIG. 4 · THE PAYOUT", title: "Paid out through PayPal.", body: "Thousands of three-cent charges become one PayPal payout to the seller." },
];

export function Hero({ top, vh, vw, boot }: { top: number; vh: number; vw: number; boot: number }) {
  const p = clamp(top / HERO_SCROLL);
  const seg = (a: number, b: number) => clamp((p - a) / (b - a));

  const fed = seg(0.02, 0.8);
  const shown = Math.max(boot, p > 0.005 ? BOOT_LINES + Math.ceil(fed * (LINES.length - BOOT_LINES)) : boot);
  const paperH = 30 + 104 + LINES.slice(0, shown).reduce((sum, l) => sum + LINE_H[l.kind], 0) + 30 + 14;
  // On phones the receipt sits under the text (CSS: 500px copy row, paper starts 76px into its row).
  const mobile = vw <= 760;
  const paperTop = mobile ? 76 : 162;
  const shift = Math.max(0, paperH - (mobile ? vh - 500 - paperTop - 16 : vh - 170 - 50));
  const lift = seg(0.84, 0.97);
  const paid = shown >= 15;
  const jammed = boot >= BOOT_LINES && p < 0.01;
  const done = shown >= LINES.length;
  const step = p < 0.02 ? 0 : p < 0.3 ? 1 : p < 0.55 ? 2 : p < 0.8 ? 3 : 4;

  return (
    <section data-tone="hero" className="hero" style={{ height: `calc(${HERO_SCROLL}px + min(100vh, 900px))` }}>
      <div className="hero-stage">
        <div className="hero-copy">
          <div className="hero-chapters">
            {CHAPTERS.map((c, i) => (
              <div
                key={c.kicker}
                className="hero-chapter"
                aria-hidden={step !== i}
                style={{ opacity: step === i ? 1 : 0, transform: `translateY(${step === i ? 0 : step > i ? -18 : 18}px)`, pointerEvents: step === i ? "auto" : "none" }}
              >
                <div className="kicker mono">{c.kicker}</div>
                {i === 0 ? <h1 className="serif hero-title hero-title-lg">{c.title}</h1> : <h2 className="serif hero-title">{c.title}</h2>}
                <p className="hero-body">{c.body}</p>
                {c.cta && (
                  <div className="hero-cta">
                    <a className="btn-primary" href="/app">Charge agents per request</a>
                    <a className="btn-link" href="#how">See how it works →</a>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="hero-printer-col" aria-hidden="true">
          <div className="paper-clip">
          <div className="paper" style={{ transform: `translate(-50%, ${-shift - lift * 60}px) rotate(${lift * 4}deg)` }}>
            <div className="paper-body mono">
              <div className="paper-head">
                <div className="paper-brand">TOLLGATE</div>
                <div className="paper-sub">RECEIPT FOR AN AI AGENT</div>
                <div className="paper-sub small">10 NOV 2026 · 14:32 IST</div>
                <div className="paper-rule" />
              </div>
              {LINES.slice(0, shown).map((l, i) =>
                l.kind === "row" ? (
                  <div key={i} className="paper-row">
                    <span className="paper-label">{l.label}</span>
                    <span className={`paper-value ${l.tone ?? ""}`}>{l.value}</span>
                  </div>
                ) : l.kind === "rule" ? (
                  <div key={i} className="paper-rule-row"><div className="paper-rule" /></div>
                ) : (
                  <div key={i} className="paper-total"><span>TOTAL</span><span>$0.03</span></div>
                ),
              )}
              <div style={{ height: 30 }} />
            </div>
            <div className="paper-tear" />
            <div className={`stamp mono ${paid ? "on" : ""}`}>PAID</div>
          </div>
          </div>

          <div className="printer">
            <div className="printer-body">
              <div className="printer-status">
                <span className={`led ${jammed ? "red" : "green"}`} />
                <span className="mono">{jammed ? "WAITING FOR PAYMENT" : done ? "PAID IN FULL" : "PRINTING"}</span>
              </div>
              <div className="printer-slot" />
            </div>
          </div>
          <div className="jam mono" style={{ opacity: jammed ? 1 : 0, top: `${paperTop + paperH - shift + 16}px` }}>
            <span className="jam-dot" /> JAMMED AT 402 · SCROLL TO PAY
          </div>
        </div>
      </div>
    </section>
  );
}
