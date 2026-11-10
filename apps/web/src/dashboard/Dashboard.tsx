import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthError, HubApi, usd, type Approval, type HubEvent, type Overview, type Payout, type Txn } from "./api";
import { OwnerView } from "./OwnerView";
import { SellerView } from "./SellerView";
import { Timeline } from "./Timeline";
import { Logo } from "../Logo";
import "./dashboard.css";

const TOKEN_KEY = "tollgate.adminToken";
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
        setAuthError("That admin token didn't work. Check HUB_ADMIN_TOKEN in your .env.");
        setToken("");
      }}
      onSignOut={() => {
        store.clear();
        setToken("");
      }}
    />
  );
}

function SignIn({ error, onSubmit }: { error: string; onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <div className="db-signin">
      <form
        className="db-signin-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
      >
        <Logo className="db-logo" />
        <h1 className="serif">Sign in to your hub</h1>
        <p className="muted">Use the admin token from <span className="mono">HUB_ADMIN_TOKEN</span> in your <span className="mono">.env</span>.</p>
        <label className="db-field">
          <span>Admin token</span>
          <input type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </label>
        {error && <div className="db-error" role="alert">{error}</div>}
        <button type="submit" className="db-btn primary wide">Open dashboard</button>
      </form>
    </div>
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
      const [ov, ap, po] = await Promise.all([api.overview(), api.pendingApprovals(), api.payouts()]);
      setOverview(ov);
      setPending(ap);
      setPayouts(po);
      setLoadError("");
    } catch (err) {
      if (err instanceof AuthError) return onAuthFail();
      setLoadError(`Can't reach the hub: ${(err as Error).message}`);
    }
  }, [api, onAuthFail]);

  const agent = overview?.agents.find((a) => a.id === agentId) ?? overview?.agents[0];
  const seller = overview?.sellers.find((s) => s.id === sellerId) ?? overview?.sellers[0];

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
          <button type="button" className="db-btn ghost small" onClick={onSignOut}>Sign out</button>
        </div>
      </header>

      {notice && <div className={`db-notice ${notice.kind}`} role="status">{notice.text}</div>}
      {loadError && <div className="db-notice error" role="alert">{loadError}</div>}

      <main id="top" className="db-main">
        {!overview ? (
          <div className="db-empty">Loading your hub…</div>
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
              onTopUp={async () => {
                // Open the tab during the click so pop-up blockers allow it, then point it at PayPal.
                const tab = window.open("about:blank", "_blank");
                try {
                  const { approveUrl } = await api.topUp(agent.id, "10.00");
                  if (tab) tab.location.href = approveUrl;
                  else window.location.href = approveUrl;
                  setNotice({ kind: "info", text: "Finish the $10.00 payment in the PayPal tab. The balance updates when it's done." });
                } catch (err) {
                  tab?.close();
                  fail(err);
                }
              }}
              onSavePolicy={(patch) => act(() => api.updatePolicy(agent.id, patch), "Rules saved. They apply to the next payment.")}
            />
          ) : (
            <NoData what="agent" />
          )
        ) : seller ? (
          <SellerView
            overview={overview}
            seller={seller}
            onPickSeller={setSellerId}
            payouts={payouts.filter((p) => p.sellerId === seller.id)}
            txns={sellerTxns}
            onPayout={() => act(() => api.payout(seller.id), "Payout sent to PayPal. Its status updates in a few seconds.")}
          />
        ) : (
          <NoData what="seller" />
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
              <div><div className="muted small">Hub URL</div><div className="mono">{window.location.origin}</div></div>
              {agent && <div><div className="muted small">Agent id</div><div className="mono">{agent.id}</div></div>}
              {seller && <div><div className="muted small">Seller id</div><div className="mono">{seller.id}</div></div>}
              <div><div className="muted small">Receipt keys</div><a className="mono" href="/.well-known/tollgate.json" target="_blank" rel="noreferrer">/.well-known/tollgate.json</a></div>
            </div>
            <pre className="mono db-code">{`app.get("/v1/report",\n  tollgate({ hubUrl: "${window.location.origin}", sellerId: "${seller?.id ?? "slr_..."}", price: "0.03" }),\n  handler);`}</pre>
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

function NoData({ what }: { what: string }) {
  return (
    <div className="db-card db-empty">
      <h2 className="serif">No {what} yet</h2>
      <p className="muted">Create the demo agent and sellers with <span className="mono">npm run try setup</span>, then refresh.</p>
    </div>
  );
}
