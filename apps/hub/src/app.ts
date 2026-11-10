import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { usdToMicros, microsToUsd, MoneyError, WELL_KNOWN_PATH } from "@tollgate/protocol";
import type { Hub } from "./hub.ts";
import { publicKeys } from "./keys.ts";
import { AppError } from "./errors.ts";
import { PayPalError, PayPalMock } from "./paypal/index.ts";
import { page, escape } from "./pages.ts";
import type { AgentPolicy } from "./services/participants.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./config.ts";
import type { User } from "./services/users.ts";

/**
 * HTTP API. All amounts in JSON are integer micros (1 USD = 1,000,000)
 * unless the field name ends in "Usd".
 */
export function createApp(hub: Hub) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "100kb" }));

  const usd = z
    .union([z.string(), z.number()])
    .transform((value, ctx) => {
      try {
        return usdToMicros(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid USD amount" });
        return z.NEVER;
      }
    });

  const policyInput = z
    .object({
      dailyLimitUsd: usd.optional(),
      maxPerRequestUsd: usd.optional(),
      approvalAboveUsd: usd.optional(),
      allowedHosts: z.array(z.string().min(1)).max(50).optional(),
    })
    .strict()
    .transform((p) => {
      const policy: Partial<AgentPolicy> = {};
      if (p.dailyLimitUsd !== undefined) policy.dailyLimit = p.dailyLimitUsd;
      if (p.maxPerRequestUsd !== undefined) policy.maxPerRequest = p.maxPerRequestUsd;
      if (p.approvalAboveUsd !== undefined) policy.approvalAbove = p.approvalAboveUsd;
      if (p.allowedHosts !== undefined) policy.allowedHosts = p.allowedHosts.map((h) => h.toLowerCase());
      return policy;
    });

  // ── Public ──────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({ ok: true, paypalMode: hub.paypal.mode });
  });

  // Sellers fetch this to verify receipts offline.
  app.get(WELL_KNOWN_PATH, (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json(publicKeys(hub.config.hubUrl, hub.signingKey));
  });

  // ── Agent API (Authorization: Bearer tg_agent_...) ──────────

  const agentApi = express.Router();
  agentApi.use((req, res, next) => {
    const key = (req.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const agent = key.startsWith("tg_agent_") ? hub.participants.findAgentByKey(key) : undefined;
    if (!agent) return next(new AppError(401, "unauthorized", "Missing or invalid agent API key"));
    res.locals.agent = agent;
    next();
  });

  // Pay a seller's quote. Returns a signed receipt, or asks for human approval.
  agentApi.post("/pay", (req, res) => {
    const body = z.object({ quote: z.unknown(), approvalId: z.string().optional() }).parse(req.body);
    const result = hub.payments.pay(res.locals.agent, body.quote, body.approvalId);
    res.status(result.status === "paid" ? 200 : 202).json(result);
  });

  agentApi.get("/wallet", (_req, res) => {
    const agent = res.locals.agent;
    res.json({
      agentId: agent.id,
      name: agent.name,
      balance: hub.ledger.balance(agent.accountId),
      spentToday: hub.payments.spentToday(agent),
      policy: agent.policy,
    });
  });

  agentApi.get("/approvals/:id", (req, res) => {
    const approval = hub.approvals.get(param(req, "id"));
    if (approval.agentId !== res.locals.agent.id) throw new AppError(404, "not_found", "Approval not found");
    res.json({ approval });
  });

  app.use("/v1", agentApi);

  // PayPal sends the buyer back here after approving the payment.
  app.get("/paypal/return", async (req, res) => {
    const orderId = String(req.query.token ?? "");
    try {
      const topup = await hub.topups.complete(orderId);
      const agent = hub.participants.getAgent(topup.agentId);
      const balance = hub.ledger.balance(agent.accountId);
      res.send(
        page(
          "Wallet topped up",
          `<h1>Wallet topped up</h1>
           <div class="amount">+$${microsToUsd(topup.amount)}</div>
           <p>Added to <strong>${escape(agent.name)}</strong>.</p>
           <p>New balance: <strong>$${microsToUsd(balance)}</strong></p>
           <a class="btn" href="${escape(hub.config.webUrl)}/app">Back to the dashboard</a>`,
          "ok",
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(err instanceof AppError ? err.status : 502).send(
        page("Top-up not completed", `<h1>Top-up not completed</h1><p>${escape(message)}</p>`, "error"),
      );
    }
  });

  app.get("/paypal/cancel", (req, res) => {
    const orderId = String(req.query.token ?? "");
    try {
      hub.topups.cancel(orderId);
    } catch {
      // Unknown order: nothing to cancel.
    }
    res.send(page("Top-up cancelled", "<h1>Top-up cancelled</h1><p>No money was taken. You can close this tab.</p>", "warn"));
  });

  // Simulated PayPal checkout, only when running without real PayPal keys.
  if (hub.paypal instanceof PayPalMock) {
    const mock = hub.paypal;
    app.get("/mock-paypal/checkout/:orderId", (req, res) => {
      const order = mock.orders.get(req.params.orderId);
      if (!order) return void res.status(404).send(page("Not found", "<h1>Order not found</h1>", "error"));
      res.send(
        page(
          "Simulated PayPal",
          `<h1>Simulated PayPal checkout</h1>
           <p>Real PayPal keys aren't configured, so this page stands in for paypal.com.</p>
           <div class="amount">$${(order.input.amountCents / 100).toFixed(2)}</div>
           <p>${escape(order.input.description)}</p>
           <form method="post" action="/mock-paypal/checkout/${escape(order.id)}/approve"><button>Pay (simulated)</button></form>`,
        ),
      );
    });
    app.post("/mock-paypal/checkout/:orderId/approve", (req, res) => {
      const order = mock.approve(req.params.orderId);
      res.redirect(303, `${order.input.returnUrl}?token=${encodeURIComponent(order.id)}`);
    });
  }

  // ── Accounts (public) ───────────────────────────────────────

  const credentials = z.object({ email: z.email().max(200), password: z.string().min(8, "Use at least 8 characters").max(200) });
  const authLimit = rateLimit(20, 15 * 60_000);

  app.post("/api/auth/signup", authLimit, (req, res) => {
    if (!hub.config.allowSignups) throw new AppError(403, "signups_closed", "Sign-ups are closed on this hub.");
    const body = credentials.parse(req.body);
    res.status(201).json(hub.users.signup(body.email, body.password));
  });

  app.post("/api/auth/login", authLimit, (req, res) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(200) }).parse(req.body);
    res.json(hub.users.login(body.email, body.password));
  });

  // ── Dashboard API (Bearer: a user session or HUB_ADMIN_TOKEN) ──
  // Users only see and change their own agents and sellers. The admin token sees everything.

  const admin = express.Router();
  admin.use(authenticate(hub));

  const scopeOf = (res: Response): Scope => res.locals.scope;
  const ownerFilter = (res: Response) => {
    const scope = scopeOf(res);
    return scope.kind === "admin" ? undefined : scope.user.id;
  };
  const mine = (res: Response, ownerId: string | null) => {
    const scope = scopeOf(res);
    return scope.kind === "admin" || ownerId === scope.user.id;
  };
  const ownAgent = (res: Response, id: string) => {
    const agent = hub.participants.getAgent(id);
    if (!mine(res, agent.ownerId)) throw new AppError(404, "not_found", "Agent not found");
    return agent;
  };
  const ownSeller = (res: Response, id: string) => {
    const seller = hub.participants.getSeller(id);
    if (!mine(res, seller.ownerId)) throw new AppError(404, "not_found", "Seller not found");
    return seller;
  };
  const owns = (res: Response, ids: { agentId?: unknown; sellerId?: unknown }) => {
    if (scopeOf(res).kind === "admin") return true;
    try {
      if (typeof ids.agentId === "string" && mine(res, hub.participants.getAgent(ids.agentId).ownerId)) return true;
      if (typeof ids.sellerId === "string" && mine(res, hub.participants.getSeller(ids.sellerId).ownerId)) return true;
    } catch {
      // Unknown id: not theirs.
    }
    return false;
  };
  const adminOnly = (_req: Request, res: Response, next: NextFunction) =>
    next(scopeOf(res).kind === "admin" ? undefined : new AppError(403, "forbidden", "Only the hub admin can do this"));
  const MAX_PER_USER = 20;

  admin.get("/auth/me", (_req, res) => {
    const scope = scopeOf(res);
    res.json(scope.kind === "admin" ? { kind: "admin" } : { kind: "user", user: scope.user });
  });

  admin.post("/auth/logout", (req, res) => {
    const token = bearer(req);
    if (token.startsWith("tg_sess_")) hub.users.logout(token);
    res.json({ ok: true });
  });

  admin.get("/overview", (_req, res) => {
    const owner = ownerFilter(res);
    const agents = hub.participants.listAgents(owner);
    const sellers = hub.participants.listSellers(owner);
    const audit = hub.ledger.audit();
    const scope = scopeOf(res);
    res.json({
      hubUrl: hub.config.hubUrl,
      paypalMode: hub.paypal.mode,
      feeBps: hub.config.feeBps,
      minPayout: hub.config.minPayoutMicros,
      me: scope.kind === "admin" ? { kind: "admin" } : { kind: "user", email: scope.user.email },
      agents: agents.map((a) => ({ ...a, spentToday: hub.payments.spentToday(a) })),
      sellers,
      // Users see whether the ledger balances and how many of the transactions are theirs.
      audit:
        scope.kind === "admin"
          ? audit
          : { ok: audit.ok, txnCount: hub.ledger.countTxns([...agents.map((a) => a.accountId), ...sellers.map((s) => s.accountId)]) },
    });
  });

  admin.post("/agents", (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), policy: policyInput.optional() }).parse(req.body);
    const owner = ownerFilter(res);
    if (owner && hub.participants.listAgents(owner).length >= MAX_PER_USER) {
      throw new AppError(409, "limit_reached", `You can have up to ${MAX_PER_USER} agents.`);
    }
    res.status(201).json(hub.participants.createAgent(body.name, body.policy, owner ?? null));
  });

  admin.get("/agents", (_req, res) => {
    res.json({ agents: hub.participants.listAgents(ownerFilter(res)) });
  });

  admin.patch("/agents/:id/policy", (req, res) => {
    const agent = ownAgent(res, param(req, "id"));
    res.json({ agent: hub.participants.updatePolicy(agent.id, policyInput.parse(req.body)) });
  });

  admin.post("/agents/:id/key", (req, res) => {
    const agent = ownAgent(res, param(req, "id"));
    if (hub.demo.get(ownerFilter(res) ?? null)?.agentId === agent.id) {
      throw new AppError(409, "demo_agent", "The demo agent's key is managed by the hub.");
    }
    res.json(hub.participants.rotateAgentKey(agent.id));
  });

  admin.post("/agents/:id/topups", async (req, res) => {
    const agent = ownAgent(res, param(req, "id"));
    const body = z.object({ amountUsd: usd }).parse(req.body);
    res.status(201).json(await hub.topups.start(agent.id, body.amountUsd));
  });

  admin.get("/topups", (_req, res) => {
    res.json({ topups: hub.topups.list(200).filter((t) => owns(res, { agentId: t.agentId })).slice(0, 50) });
  });

  // Lets an operator finish a top-up if the buyer closed the tab before the redirect.
  admin.post("/topups/capture", adminOnly, async (req, res) => {
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    res.json({ topup: await hub.topups.complete(body.orderId) });
  });

  admin.post("/sellers", (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), paypalEmail: z.email().optional() }).parse(req.body);
    const owner = ownerFilter(res);
    if (owner && hub.participants.listSellers(owner).length >= MAX_PER_USER) {
      throw new AppError(409, "limit_reached", `You can have up to ${MAX_PER_USER} sellers.`);
    }
    res.status(201).json(hub.participants.createSeller(body.name, body.paypalEmail, owner ?? null));
  });

  admin.get("/sellers", (_req, res) => {
    res.json({ sellers: hub.participants.listSellers(ownerFilter(res)) });
  });

  admin.patch("/sellers/:id", (req, res) => {
    const seller = ownSeller(res, param(req, "id"));
    const body = z.object({ paypalEmail: z.email() }).parse(req.body);
    res.json({ seller: hub.participants.updateSellerEmail(seller.id, body.paypalEmail) });
  });

  admin.post("/sellers/:id/payouts", async (req, res) => {
    const seller = ownSeller(res, param(req, "id"));
    const body = z.object({ amountUsd: usd.optional() }).parse(req.body ?? {});
    res.status(201).json({ payout: await hub.payouts.request(seller.id, body.amountUsd) });
  });

  admin.get("/payouts", (_req, res) => {
    res.json({ payouts: hub.payouts.list(200).filter((p) => owns(res, { sellerId: p.sellerId })).slice(0, 50) });
  });

  admin.post("/payouts/:id/refresh", async (req, res) => {
    const payout = hub.payouts.get(param(req, "id"));
    ownSeller(res, payout.sellerId);
    res.json({ payout: await hub.payouts.refresh(payout.id) });
  });

  admin.get("/approvals", (req, res) => {
    const status = req.query.status ? (String(req.query.status) as Parameters<typeof hub.approvals.list>[0]) : undefined;
    res.json({ approvals: hub.approvals.list(status, 200).filter((a) => owns(res, { agentId: a.agentId })).slice(0, 50) });
  });

  // Only the agent's owner decides; the seller can't approve its own sale.
  admin.post("/approvals/:id/approve", (req, res) => {
    ownAgent(res, hub.approvals.get(param(req, "id")).agentId);
    res.json({ approval: hub.approvals.decide(param(req, "id"), "approved") });
  });

  admin.post("/approvals/:id/deny", (req, res) => {
    ownAgent(res, hub.approvals.get(param(req, "id")).agentId);
    res.json({ approval: hub.approvals.decide(param(req, "id"), "denied") });
  });

  admin.get("/receipts", (_req, res) => {
    const receipts = hub.payments.recentReceipts(200).filter((r) => owns(res, { agentId: r.agent_id, sellerId: r.seller_id }));
    res.json({ receipts: receipts.slice(0, 50) });
  });

  admin.get("/ledger/txns", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
    if (scopeOf(res).kind !== "admin") {
      const owner = ownerFilter(res);
      const accounts = [...hub.participants.listAgents(owner), ...hub.participants.listSellers(owner)].map((p) => p.accountId);
      if (!accountId || !accounts.includes(accountId)) throw new AppError(404, "not_found", "Account not found");
    }
    res.json({ txns: hub.ledger.recentTxns(limit, accountId) });
  });

  admin.get("/ledger/audit", adminOnly, (_req, res) => {
    res.json(hub.ledger.audit());
  });

  // Testing helper: makes an agent pay a seller N times without the full request flow.
  admin.post("/simulate/charges", adminOnly, (req, res) => {
    const body = z
      .object({
        agentId: z.string(),
        sellerId: z.string(),
        priceUsd: usd,
        count: z.number().int().min(1).max(1000).default(1),
      })
      .parse(req.body);
    const results = [];
    for (let i = 0; i < body.count; i++) {
      results.push(
        hub.charges.charge({
          agentId: body.agentId,
          sellerId: body.sellerId,
          price: body.priceUsd,
          idempotencyKey: `sim:${Date.now()}:${i}:${Math.random()}`,
          memo: "Simulated charge",
          meta: { simulated: true },
        }),
      );
    }
    res.status(201).json({ charges: results.length, agentBalance: results.at(-1)?.agentBalance });
  });

  // ── Hosted demo: a Research Agent that runs on the hub ─────

  admin.get("/demo", (_req, res) => {
    res.json(hub.demo.status(ownerFilter(res) ?? null));
  });

  admin.post("/demo/setup", (_req, res) => {
    const ws = hub.demo.setup(ownerFilter(res) ?? null);
    res.status(201).json({ ...hub.demo.status(ownerFilter(res) ?? null), agentId: ws.agentId });
  });

  admin.post("/demo/run", async (req, res) => {
    const body = z.object({ task: z.string().max(400).optional() }).parse(req.body ?? {});
    res.status(202).json(await hub.demo.run(ownerFilter(res) ?? null, body.task));
  });

  // Live event stream for the dashboard. EventSource can't send headers, so ?token= is accepted.
  // Users only receive events about their own agents and sellers.
  admin.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    // Some proxies (including dev servers) only pass the stream on after the first bytes.
    res.write(": connected\n\n");
    const send = (event: { id: number; type: string; data: Record<string, unknown> }) => {
      if (owns(res, event.data)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const lastId = Number(req.get("Last-Event-ID") ?? req.query.after ?? 0) || 0;
    hub.events.history(lastId).forEach(send);
    const unsubscribe = hub.events.subscribe(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  app.use("/api", admin);

  // ── Website: landing page at /, dashboard at /app ──────────
  // Served from apps/web/dist after `npm run build`. In development, Vite serves it instead.

  const webDist = join(REPO_ROOT, "apps", "web", "dist");
  if (existsSync(join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: "index.html", maxAge: "1h" }));
    app.get(/^\/app(\/.*)?$/, (_req, res) => res.sendFile(join(webDist, "index.html")));
  } else {
    // Not built yet: point people to the dev server or the build command instead of a bare 404.
    app.get(["/", /^\/app(\/.*)?$/], (req, res) => {
      res.status(503).send(
        page(
          "Website not built",
          `<h1>The website isn't built yet</h1>
           <p>Either run <code>npm run build</code> and restart the hub, or run <code>npm run dev</code> and open the dev server:</p>
           <a class="btn" href="http://localhost:5173${escape(req.originalUrl)}">Open localhost:5173${escape(req.originalUrl)}</a>`,
          "warn",
        ),
      );
    });
  }

  // ── Errors ──────────────────────────────────────────────────

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return void res.status(400).json({ error: { code: "bad_request", message: "Invalid request body", details: err.issues } });
    }
    if (err instanceof MoneyError) {
      return void res.status(400).json({ error: { code: "bad_amount", message: err.message } });
    }
    if (err instanceof AppError) {
      return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof PayPalError) {
      return void res
        .status(502)
        .json({ error: { code: "paypal_error", message: `${err.name}: ${err.message}`, details: { debugId: err.debugId, issues: err.details } } });
    }
    if (err instanceof SyntaxError && "body" in err) {
      return void res.status(400).json({ error: { code: "bad_json", message: "Request body is not valid JSON" } });
    }
    console.error(err);
    res.status(500).json({ error: { code: "internal", message: "Internal server error" } });
  });

  return app;
}

type Scope = { kind: "admin" } | { kind: "user"; user: User };

function bearer(req: Request): string {
  const header = req.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : String(req.query.token ?? "");
}

/** Accepts a user session token (tg_sess_...) or the hub's admin token. */
function authenticate(hub: Hub) {
  const expected = createHash("sha256").update(hub.config.adminToken).digest();
  return (req: Request, res: Response, next: NextFunction) => {
    const given = bearer(req);
    if (given.startsWith("tg_sess_")) {
      const user = hub.users.fromSession(given);
      if (!user) return next(new AppError(401, "unauthorized", "Your session expired. Log in again."));
      res.locals.scope = { kind: "user", user } satisfies Scope;
      return next();
    }
    const actual = createHash("sha256").update(given).digest();
    if (!given || !timingSafeEqual(expected, actual)) {
      return next(new AppError(401, "unauthorized", "Missing or wrong admin token"));
    }
    res.locals.scope = { kind: "admin" } satisfies Scope;
    next();
  };
}

/** Small in-memory limiter for the login and sign-up endpoints. */
function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { count: number; reset: number }>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const entry = hits.get(key);
    if (!entry || entry.reset < now) hits.set(key, { count: 1, reset: now + windowMs });
    else if (++entry.count > max) return next(new AppError(429, "too_many_attempts", "Too many attempts. Try again in a few minutes."));
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

function param(req: Request, name: string): string {
  return String(req.params[name]);
}
