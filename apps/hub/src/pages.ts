/** Small server-rendered pages for the PayPal return flow. */

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function page(title: string, body: string, tone: "ok" | "warn" | "error" | "neutral" = "neutral"): string {
  const accent = { ok: "#16a34a", warn: "#d97706", error: "#dc2626", neutral: "#2563eb" }[tone];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · Tollgate</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#111827; --muted:#6b7280; --border:#e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0d12; --card:#151922; --text:#f3f4f6; --muted:#9ca3af; --border:#262b36; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
         font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:28px; max-width:440px; width:100%; }
  .brand { font-weight:700; letter-spacing:.02em; color:var(--muted); font-size:13px; text-transform:uppercase; }
  h1 { margin:8px 0 12px; font-size:22px; border-left:4px solid ${accent}; padding-left:10px; }
  p { margin:8px 0; color:var(--muted); } strong { color:var(--text); }
  .amount { font-size:32px; font-weight:700; color:var(--text); margin:12px 0; font-variant-numeric:tabular-nums; }
  button, .btn { display:inline-block; margin-top:16px; padding:12px 18px; border-radius:10px; border:0; cursor:pointer;
         background:${accent}; color:#fff; font:600 15px system-ui,sans-serif; text-decoration:none; }
  code { font-size:13px; }
</style></head>
<body><div class="card"><div class="brand">Tollgate</div>${body}</div></body></html>`;
}

export { escape };
