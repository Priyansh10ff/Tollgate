import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthError, HubApi, authenticate, usd, type Approval, type DemoStatus, type HubEvent, type Overview, type Payout, type Txn } from "./api";
import { OwnerView } from "./OwnerView";
import { SellerView } from "./SellerView";
import { Timeline } from "./Timeline";
import { CreateAgent, CreateSeller, Reveal, type Created } from "./Setup";
import { DemoRun, TryDemo } from "./DemoRun";
import { Logo } from "../Logo";
import "./dashboard.css";

const TOKEN_KEY = "tollgate.token";
const store = {
  get: () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } },
  set: (v: string) => { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* storage unavailable */ } },
  clear: () => { try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } },
};

export interface Notice { kind: "ok" | "error" | "info"; text: string }

export function Dashboard() {
  const [token, setToken] = useState(store.get);
  const [authError, setAuthError] = useState("");
  if (!token) {
    return (
      <SignIn
        error={authError}
        onSubmit={(t) => {
          store.set(t);
          setAuthError("");
          setToken(t);
        }}
      />
    );
  }
  return (
    <Signed
      token={token}
      onAuthFail={() => {
        store.clear();
        setAuthError("Your session ended. Please log in again.");
        setToken("");
      }}
      onSignOut={() => {
        store.clear();
        setToken("");
      }}
    />
  );
}

type Mode = "login" | "signup" | "admin";

function SignIn({ error, onSubmit }: { error: string; onSubmit: (token: string) => void }) {
  const [mode, setMode] = useState<Mode>(() => (new URLSearchParams(window.location.search).has("signup") ? "signup" : "login"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const shown = formError || error;

  const submit = async () => {
    if (mode === "admin") return adminToken.trim() && onSubmit(adminToken.trim());
    setBusy(true);
    setFormError("");
    try {
      onSubmit(await authenticate(mode, email.trim(), password));
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="db-signin">
      <AuthStory />
      <div className="db-signin-side">
      <form
        className="db-signin-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Logo className="db-logo" />
        {mode === "admin" ? (
          <>
            <h1 className="serif">Hub admin</h1>
            <p className="muted">Running your own hub? Use the token from <span className="mono">HUB_ADMIN_TOKEN</span>. It sees every agent and seller.</p>
            <PasswordField label="Admin token" value={adminToken} onChange={setAdminToken} autoComplete="current-password" autoFocus />
          </>
        ) : (
          <>
            <h1 className="serif">{mode === "signup" ? "Create your account" : "Welcome back"}</h1>
            <p className="muted">
              {mode === "signup"
                ? "Give your AI agents a wallet with spending limits, or start charging agents for your API."
                : "Log in to see your agents' wallets, approvals and earnings."}
            </p>
            <div className="db-signin-tabs" role="tablist" aria-label="Account">
              <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "on" : ""} onClick={() => { setMode("login"); setFormError(""); }}>Log in</button>
              <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "on" : ""} onClick={() => { setMode("signup"); setFormError(""); }}>Sign up</button>
            </div>
            <label className="db-field">
              <span>Email</span>
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <PasswordField
              label={mode === "signup" ? "Password (8+ characters)" : "Password"}
              value={password}
              onChange={setPassword}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              minLength={mode === "signup" ? 8 : undefined}
            />
          </>
        )}
        {shown && <div className="db-error" role="alert">{shown}</div>}
        <button type="submit" className="db-btn primary wide" disabled={busy}>
          {busy ? "One moment…" : mode === "signup" ? "Create account" : mode === "login" ? "Log in" : "Open dashboard"}
        </button>
        <button type="button" className="db-linkish" onClick={() => { setMode(mode === "admin" ? "login" : "admin"); setFormError(""); }}>
          {mode === "admin" ? "Log in with email instead" : "Hub admin? Use the admin token"}
        </button>
      </form>
      </div>
    </div>
  );
}

function PasswordField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <label className="db-field">
      <span>{props.label}</span>
      <span className="db-pw">
        <input
          type={show ? "text" : "password"}
          autoComplete={props.autoComplete}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          minLength={props.minLength}
          autoFocus={props.autoFocus}
          required
        />
        <button type="button" className="db-pw-toggle" aria-label={show ? "Hide password" : "Show password"} aria-pressed={show} onClick={() => setShow(!show)}>
          {show ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3l18 18" /><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c5 0 9 4.5 10 7-.4 1-1.3 2.4-2.6 3.7M6.5 6.6C4.4 8 2.8 10.2 2 12c1 2.5 5 7 10 7 1.8 0 3.4-.6 4.8-1.4" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </span>
    </label>
  );
}

const FEED = [
  { tone: "pay", who: "Research Agent", what: "Company profile · Atlas Data", amount: "−$0.02" },
  { tone: "pay", who: "Research Agent", what: "Financials · Atlas Data", amount: "−$0.05" },
  { tone: "wait", who: "Needs you", what: "Full report · over your $0.25 limit", amount: "$0.50" },
  { tone: "ok", who: "You approved", what: "Full report · NVIDIA", amount: "−$0.50" },
  { tone: "stop", who: "Blocked", what: "QuickLeads isn't on the allowed list", amount: "$0.00" },
  { tone: "money", who: "Payout", what: "Atlas Data → PayPal", amount: "+$1.06" },
];

/** The left side of the sign-in page: what Tollgate does, as a live-looking feed. */
function AuthStory() {
  return (
    <aside className="db-auth-story" aria-hidden="true">
      <div className="db-auth-blob a" />
      <div className="db-auth-blob b" />
      <div className="db-auth-copy">
        <div className="db-auth-kicker mono">PAY-PER-REQUEST FOR AI AGENTS</div>
        <h2 className="serif">Your agents can pay now.<br /><em>Within your rules.</em></h2>
        <p>Fund a wallet with PayPal. Set a daily budget, a max per request, and when it has to ask you. Every cent lands in a ledger you can audit.</p>
      </div>
      <ol className="db-auth-feed">
        {FEED.map((f, i) => (
          <li key={i} className={`db-auth-row ${f.tone}`} style={{ animationDelay: `${i * 0.9}s` }}>
            <span className="dot" />
            <span className="who">{f.who}</span>
            <span className="what">{f.what}</span>
            <span className="mono amt">{f.amount}</span>
          </li>
        ))}
      </ol>
      <div className="db-auth-foot mono">Settled through PayPal · Receipts signed with Ed25519</div>
    </aside>
  );
}

function Signed({ token, onAuthFail, onSignOut }: { token: string; onAuthFail: () => void; onSignOut: () => void }) {
  const api = useMemo(() => new HubApi(token), [token]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [pending, setPending] = useState<Approval[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [sellerTxns, setSellerTxns] = useState<Txn[]>([]);
  const [events, setEvents] = useState<HubEvent[]>([]);
  const [live, setLive] = useState(false);
  const [role, setRole] = useState<"owner" | "seller">("owner");
  const [agentId, setAgentId] = useState("");
  const [sellerId, setSellerId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [loadError, setLoadError] = useState("");
  const [panel, setPanel] = useState<"agent" | "seller" | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [demo, setDemo] = useState<DemoStatus | null>(null);
  const refreshTimer = useRef<number>(0);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof AuthError) return onAuthFail();
      setNotice({ kind: "error", text: (err as Error).message });
    },
    [onAuthFail],
  );

  const load = useCallback(async () => {
    try {
      const [ov, ap, po, dm] = await Promise.all([api.overview(), api.pendingApprovals(), api.payouts(), api.demo()]);
      setOverview(ov);
      setDemo(dm);
      setPending(ap);
      setPayouts(po);
      setLoadError("");
    } catch (err) {
      if (err instanceof AuthError) return onAuthFail();
      setLoadError(`Can't reach the hub: ${(err as Error).message}`);
    }
  }, [api, onAuthFail]);

  // Default to the live demo agent if there is one, else the newest agent.
  const agent =
    overview?.agents.find((a) => a.id === agentId) ??
    overview?.agents.find((a) => a.id === demo?.agentId) ??
    overview?.agents.at(-1);
  const seller =
    overview?.sellers.find((s) => s.id === sellerId) ??
    [...(overview?.sellers ?? [])].reverse().find((s) => !!s.paypalEmail) ??
    overview?.sellers[0];

  const loadSellerTxns = useCallback(async () => {
    if (!seller) return;
    try {
      setSellerTxns(await api.txns(seller.accountId));
    } catch (err) {
      fail(err);
    }
  }, [api, seller?.accountId, fail]);

  useEffect(() => {
    load();
    const poll = window.setInterval(load, 15_000);
    const stop = api.subscribe(
      (e) => {
        setEvents((list) => (list.some((x) => x.id === e.id) ? list : [e, ...list].slice(0, 200)));
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(load, 250);
      },
      setLive,
    );
    return () => {
      stop();
      window.clearInterval(poll);
      window.clearTimeout(refreshTimer.current);
    };
  }, [api, load]);

  useEffect(() => {
    if (role === "seller") loadSellerTxns();
  }, [role, loadSellerTxns, events.length]);

  // Coming back from PayPal checkout: show how it went, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("topup");
    if (!result) return;
    if (result === "ok") setNotice({ kind: "ok", text: `Added $${params.get("amount") ?? ""} from PayPal to the wallet.` });
    if (result === "cancelled") setNotice({ kind: "info", text: "Top-up cancelled. No money was taken." });
    if (result === "failed") setNotice({ kind: "error", text: `Top-up not completed: ${params.get("reason") ?? "unknown error"}` });
    window.history.replaceState(null, "", "/app");
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) setNotice({ kind: "ok", text: ok });
      load();
    } catch (err) {
      fail(err);
    }
  };

  const isOwner = role === "owner";
  const hubUrl = overview?.hubUrl ?? window.location.origin;
  const me = overview?.me;

  const createAgent = async (name: string) => {
    try {
      const res = await api.createAgent(name);
      setCreated({ kind: "agent", agent: res.agent, apiKey: res.apiKey });
      setAgentId(res.agent.id);
      setRole("owner");
      setPanel(null);
      load();
    } catch (err) {
      fail(err);
    }
  };
  const createSeller = async (name: string, email: string) => {
    try {
      const res = await api.createSeller(name, email);
      setCreated({ kind: "seller", seller: res.seller });
      setSellerId(res.seller.id);
      setRole("seller");
      setPanel(null);
      load();
    } catch (err) {
      fail(err);
    }
  };
  const topUp = async () => {
    if (!agent) return;
    try {
      // Same tab: PayPal sends the buyer straight back to /app when they're done.
      setNotice({ kind: "info", text: "Opening PayPal…" });
      const { approveUrl } = await api.topUp(agent.id, "10.00");
      window.location.assign(approveUrl);
    } catch (err) {
      fail(err);
    }
  };
  const startDemo = async () => {
    try {
      const res = await api.demoSetup();
      setAgentId(res.agentId);
      setRole("owner");
      setPanel(null);
      await load();
    } catch (err) {
      fail(err);
    }
  };
  const runDemo = async (task: string) => {
    try {
      const res = await api.demoRun(task);
      setNotice({ kind: "info", text: res.mode === "claude" ? "The agent is running on Claude. Watch it work below." : "The agent is running in replay mode. Watch it work below." });
      load();
    } catch (err) {
      fail(err);
    }
  };
  const newKey = async () => {
    if (!agent) return;
    if (!window.confirm(`Make a new API key for ${agent.name}? The current key stops working right away.`)) return;
    try {
      const res = await api.newAgentKey(agent.id);
      setCreated({ kind: "agent", agent: res.agent, apiKey: res.apiKey });
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="db">
      <header className="db-header">
        <div className="db-header-left">
          <Logo className="db-logo" />
          <nav className="db-nav" aria-label="Sections">
            <a href="#top" className="on">Home</a>
            <a href="#timeline">Activity</a>
            <a href="#rules">{isOwner ? "Rules" : "Earnings"}</a>
            <a href="#developers">Developers</a>
          </nav>
        </div>
        <div className="db-header-right">
          <span className={`db-pill ${live ? "ok" : ""}`} title={live ? "Receiving live events" : "Reconnecting"}>
            <span className="dot" /> {live ? "Live" : "Connecting"}
          </span>
          {overview && <span className="db-pill">{overview.paypalMode === "mock" ? "Simulated PayPal" : `PayPal ${overview.paypalMode}`}</span>}
          {overview && <span className={`db-pill ${overview.audit.ok ? "ok" : "bad"}`}>{overview.audit.ok ? "✓ Ledger balanced" : "Ledger problem"}</span>}
          <div className="db-switch" role="group" aria-label="View as">
            <button type="button" aria-pressed={isOwner} className={isOwner ? "on" : ""} onClick={() => setRole("owner")}>Owner</button>
            <button type="button" aria-pressed={!isOwner} className={!isOwner ? "on" : ""} onClick={() => setRole("seller")}>Seller</button>
          </div>
          {me?.kind === "user" && <span className="db-me" title={me.email}>{me.email}</span>}
          <button
            type="button"
            className="db-btn ghost small"
            onClick={() => {
              api.logout().catch(() => undefined);
              onSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {notice && <div className={`db-notice ${notice.kind}`} role="status">{notice.text}</div>}
      {loadError && <div className="db-notice error" role="alert">{loadError}</div>}

      <main id="top" className="db-main">
        {!overview ? (
          <div className="db-empty">Loading your hub…</div>
        ) : created ? (
          <Reveal created={created} hubUrl={hubUrl} onDone={() => setCreated(null)} />
        ) : panel === "agent" ? (
          <CreateAgent onCreate={createAgent} onCancel={() => setPanel(null)} />
        ) : panel === "seller" ? (
          <CreateSeller onCreate={createSeller} onCancel={() => setPanel(null)} />
        ) : isOwner ? (
          agent ? (
            <OwnerView
              overview={overview}
              agent={agent}
              onPickAgent={setAgentId}
              pending={pending.filter((a) => a.agentId === agent.id)}
              events={events}
              onApprove={(id) => act(() => api.approve(id), "Approved. The agent will pay and continue.")}
              onDeny={(id) => act(() => api.deny(id), "Denied. No money moved.")}
              onTopUp={topUp}
              onSavePolicy={(patch) => act(() => api.updatePolicy(agent.id, patch), "Rules saved. They apply to the next payment.")}
            />
          ) : (
            <div className="db-setup-grid">
              {demo && !demo.ready && <TryDemo onStart={startDemo} />}
              <CreateAgent onCreate={createAgent} />
            </div>
          )
        ) : seller ? (
          <SellerView
            overview={overview}
            seller={seller}
            onPickSeller={setSellerId}
            payouts={payouts.filter((p) => p.sellerId === seller.id)}
            txns={sellerTxns}
            onPayout={() => act(() => api.payout(seller.id), "Payout sent to PayPal. Its status updates in a few seconds.")}
            onSaveEmail={(email) => act(() => api.updateSellerEmail(seller.id, email), "PayPal email saved.")}
          />
        ) : (
          <CreateSeller onCreate={createSeller} />
        )}

        {overview && isOwner && !created && !panel && agent && demo?.ready && demo.agentId !== agent.id && (
          <div className="db-card db-demo-hint">
            <span>Your live demo is ready on <strong>Research Agent</strong>.</span>
            <button type="button" className="db-btn soft small" onClick={() => setAgentId(demo.agentId!)}>Open the live demo</button>
          </div>
        )}

        {overview && isOwner && !created && !panel && agent && demo?.ready && demo.agentId === agent.id && (
          <DemoRun demo={demo} agent={agent} events={events} onRun={runDemo} onTopUp={topUp} />
        )}

        {overview && (
          <Timeline
            events={events}
            role={role}
            agentId={agent?.id}
            sellerId={seller?.id}
          />
        )}

        {overview && (
          <section id="developers" className="db-card db-dev">
            <h2 className="db-h2">Developers</h2>
            <div className="db-dev-grid">
              <div><div className="muted small">Hub URL</div><div className="mono">{hubUrl}</div></div>
              {agent && <div><div className="muted small">Agent id</div><div className="mono">{agent.id}</div></div>}
              {seller && <div><div className="muted small">Seller id</div><div className="mono">{seller.id}</div></div>}
              <div><div className="muted small">Receipt keys</div><a className="mono" href="/.well-known/tollgate.json" target="_blank" rel="noreferrer">/.well-known/tollgate.json</a></div>
            </div>
            <pre className="mono db-code">{`app.get("/v1/report",\n  tollgate({ hubUrl: "${hubUrl}", sellerId: "${seller?.id ?? "slr_..."}", price: "0.03" }),\n  handler);`}</pre>
            <div className="db-dev-actions">
              <button type="button" className="db-btn soft small" onClick={() => { setCreated(null); setPanel("agent"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>+ New agent wallet</button>
              <button type="button" className="db-btn soft small" onClick={() => { setCreated(null); setPanel("seller"); window.scrollTo({ top: 0, behavior: "smooth" }); }}>+ New seller</button>
              {demo && !demo.ready && <button type="button" className="db-btn soft small" onClick={startDemo}>+ Load the live demo</button>}
              {agent && demo?.agentId !== agent.id && <button type="button" className="db-btn ghost small" onClick={newKey}>New API key for {agent.name}</button>}
            </div>
          </section>
        )}
      </main>
      <footer className="db-footer muted small">
        Tollgate · {overview ? `${overview.audit.txnCount} ledger transactions · fee ${overview.feeBps / 100}%` : "connecting"} · amounts settle through PayPal
        {agent && role === "owner" && <> · wallet {usd(agent.balance, 2)}</>}
      </footer>
    </div>
  );
}
