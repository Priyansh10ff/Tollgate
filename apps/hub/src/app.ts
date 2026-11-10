import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
import { usdToMicros, microsToUsd, MoneyError } from "@tollgate/protocol";
import type { Hub } from "./hub.ts";
import { AppError } from "./errors.ts";
import { PayPalError, PayPalMock } from "./paypal/index.ts";
import { page, escape } from "./pages.ts";
import type { AgentPolicy } from "./services/participants.ts";

/**
 * HTTP API. All amounts in JSON are integer micros (1 USD = 1,000,000)
 * unless the field name ends in "Usd".
 */
export function createApp(hub: Hub) {
  const app = express();
  app.disable("x-powered-by");
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
           <p>You can close this tab.</p>`,
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

  // ── Admin API (Authorization: Bearer HUB_ADMIN_TOKEN) ───────

  const admin = express.Router();
  admin.use(requireAdmin(hub.config.adminToken));

  admin.get("/overview", (_req, res) => {
    res.json({
      paypalMode: hub.paypal.mode,
      feeBps: hub.config.feeBps,
      agents: hub.participants.listAgents(),
      sellers: hub.participants.listSellers(),
      audit: hub.ledger.audit(),
    });
  });

  admin.post("/agents", (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), policy: policyInput.optional() }).parse(req.body);
    res.status(201).json(hub.participants.createAgent(body.name, body.policy));
  });

  admin.get("/agents", (_req, res) => {
    res.json({ agents: hub.participants.listAgents() });
  });

  admin.patch("/agents/:id/policy", (req, res) => {
    res.json({ agent: hub.participants.updatePolicy(param(req, "id"), policyInput.parse(req.body)) });
  });

  admin.post("/agents/:id/topups", async (req, res) => {
    const body = z.object({ amountUsd: usd }).parse(req.body);
    res.status(201).json(await hub.topups.start(param(req, "id"), body.amountUsd));
  });

  admin.get("/topups", (_req, res) => {
    res.json({ topups: hub.topups.list() });
  });

  // Lets an operator finish a top-up if the buyer closed the tab before the redirect.
  admin.post("/topups/capture", async (req, res) => {
    const body = z.object({ orderId: z.string().min(1) }).parse(req.body);
    res.json({ topup: await hub.topups.complete(body.orderId) });
  });

  admin.post("/sellers", (req, res) => {
    const body = z.object({ name: z.string().trim().min(1).max(80), paypalEmail: z.email().optional() }).parse(req.body);
    res.status(201).json(hub.participants.createSeller(body.name, body.paypalEmail));
  });

  admin.get("/sellers", (_req, res) => {
    res.json({ sellers: hub.participants.listSellers() });
  });

  admin.patch("/sellers/:id", (req, res) => {
    const body = z.object({ paypalEmail: z.email() }).parse(req.body);
    res.json({ seller: hub.participants.updateSellerEmail(param(req, "id"), body.paypalEmail) });
  });

  admin.post("/sellers/:id/payouts", async (req, res) => {
    const body = z.object({ amountUsd: usd.optional() }).parse(req.body ?? {});
    res.status(201).json({ payout: await hub.payouts.request(param(req, "id"), body.amountUsd) });
  });

  admin.get("/payouts", (_req, res) => {
    res.json({ payouts: hub.payouts.list() });
  });

  admin.post("/payouts/:id/refresh", async (req, res) => {
    res.json({ payout: await hub.payouts.refresh(param(req, "id")) });
  });

  admin.get("/ledger/txns", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 500);
    const accountId = req.query.accountId ? String(req.query.accountId) : undefined;
    res.json({ txns: hub.ledger.recentTxns(limit, accountId) });
  });

  admin.get("/ledger/audit", (_req, res) => {
    res.json(hub.ledger.audit());
  });

  // Testing helper: makes an agent pay a seller N times without the full request flow.
  admin.post("/simulate/charges", (req, res) => {
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

  // Live event stream for the dashboard. EventSource can't send headers, so ?token= is accepted.
  admin.get("/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    const send = (event: { id: number; type: string }) => res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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

function requireAdmin(token: string) {
  const expected = createHash("sha256").update(token).digest();
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : String(req.query.token ?? "");
    const actual = createHash("sha256").update(given).digest();
    if (!given || !timingSafeEqual(expected, actual)) {
      return next(new AppError(401, "unauthorized", "Missing or wrong admin token"));
    }
    next();
  };
}

function param(req: Request, name: string): string {
  return String(req.params[name]);
}
