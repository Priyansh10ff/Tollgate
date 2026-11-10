/** Small server-rendered pages for the PayPal return flow, styled like the Tollgate website. */

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const MARK = `<svg width="30" height="30" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#4F46E5"/><rect x="11" y="13" width="42" height="11" rx="5.5" fill="#fff"/><circle cx="16.5" cy="18.5" r="2.3" fill="#4F46E5"/><path d="M25 24h14v24l-2.8 3-2.8-3-2.8 3-2.8-3-2.8 3-2.8-3z" fill="#fff"/><rect x="28.5" y="30" width="7" height="2.2" rx="1.1" fill="#4F46E5" opacity=".5"/><rect x="28.5" y="35.5" width="4.5" height="2.2" rx="1.1" fill="#4F46E5" opacity=".5"/></svg>`;

export function page(title: string, body: string, tone: "ok" | "warn" | "error" | "neutral" = "neutral"): string {
  const accent = { ok: "#059669", warn: "#d97706", error: "#dc2626", neutral: "#4f46e5" }[tone];
  const tint = { ok: "#d3f5e6", warn: "#fde9c8", error: "#fcdde6", neutral: "#dcddfe" }[tone];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Tollgate</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: light; --ink:#14142b; --muted:#5b5b76; --indigo:#4f46e5; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; color:var(--ink);
         font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; background:#f6f5ff;
         background-image: radial-gradient(40rem 28rem at 15% 10%, ${tint}, transparent 70%),
                           radial-gradient(36rem 26rem at 90% 90%, #ece9ff, transparent 70%); }
  .card { background:#fff; border-radius:24px; padding:32px; max-width:440px; width:100%;
          box-shadow: 0 30px 60px -30px rgba(79,70,229,.35), 0 1px 0 rgba(20,20,43,.04); }
  .brand { display:flex; align-items:center; gap:10px; font:400 24px Georgia,"Times New Roman",serif; color:var(--ink); }
  .brand span { color:var(--indigo); }
  h1 { margin:22px 0 6px; font:400 34px/1.15 Georgia,"Times New Roman",serif; }
  h1::before { content:""; display:inline-block; width:10px; height:10px; border-radius:50%; background:${accent}; margin:0 12px 6px 0; vertical-align:middle; }
  p { margin:8px 0; color:var(--muted); } strong { color:var(--ink); }
  .amount { font:400 56px/1 Georgia,"Times New Roman",serif; color:${accent}; margin:14px 0 10px; font-variant-numeric:tabular-nums; }
  button, .btn { display:inline-block; margin-top:20px; padding:13px 20px; border-radius:12px; border:0; cursor:pointer;
         background:var(--indigo); color:#fff; font:600 15px Inter,system-ui,sans-serif; text-decoration:none; }
  code { font-size:13px; }
</style></head>
<body><main class="card"><div class="brand">${MARK}<span class="word">Tollgate<span>.</span></span></div>${body}</main></body></html>`;
}

export { escape };
