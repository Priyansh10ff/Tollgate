import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { createDemoApis, COMPANIES } from "@tollgate/demo-api";
import { TollgateClient } from "@tollgate/client";
import { runResearchAgent, claudeModel, replayModel, type AgentStep, type ModelCall } from "@tollgate/demo-agent";
import { WELL_KNOWN_PATH, type HubKeys } from "@tollgate/protocol";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import type { EventBus } from "../events.ts";
import { AppError } from "../errors.ts";
import type { Participants } from "./participants.ts";

/**
 * The hosted demo. Each signed-in user gets their own Research Agent wallet plus two
 * demo sellers, Atlas Data and QuickLeads. The sellers run inside the hub on loopback
 * ports and are reached as https://atlas.demo and https://quickleads.demo. The agent
 * runs on the hub too, so visitors only need a browser.
 *
 * Everything else is the real flow: 402 quotes, the hub's spending rules, approvals,
 * signed receipts verified by the seller middleware, the ledger and PayPal.
 */

export const DEMO_ATLAS = "https://atlas.demo";
export const DEMO_LEADS = "https://quickleads.demo";
const SELLER_HEADER = "x-tollgate-demo-seller";
const RUNS_PER_USER_PER_DAY = 5;
const MAX_TASK_CHARS = 400;

export const DEMO_TASKS = [
  "Should we consider acquiring Northwind Robotics? Check their profile, financials and recent news, read the full analyst report, and get direct contacts for their executives so we can reach out.",
  "Is Lumen Health a good investment? Read their full analyst report.",
  "Compare Helios Grid and Quanta Foods on revenue and recent news. Keep spending low.",
];

export interface DemoWorkspace {
  agentId: string;
  agentKey: string;
  atlasSellerId: string;
  quickLeadsSellerId: string;
}

export class Demo {
  /** Where the demo agent reaches the hub's own API. server.ts points this at loopback. */
  internalHubUrl: string;
  private apis?: Promise<{ atlas: string; leads: string; close: () => void }>;
  private running = new Set<string>();
  private claudeRuns = { day: "", total: 0, byOwner: new Map<string, number>() };

  constructor(
    private db: DB,
    private participants: Participants,
    private events: EventBus,
    private config: Config,
    private keys: () => HubKeys,
    /** Tests inject a model. Otherwise Claude when configured, else the replay model. */
    private modelFactory?: (company: { slug: string; name: string }) => ModelCall,
  ) {
    this.internalHubUrl = config.hubUrl;
  }

  /** The user's demo workspace, or undefined if they haven't set one up. */
  get(ownerId: string | null): DemoWorkspace | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(settingKey(ownerId)) as { value: string } | undefined;
    if (!row) return undefined;
    const ws = JSON.parse(row.value) as DemoWorkspace;
    try {
      this.participants.getAgent(ws.agentId);
      return ws;
    } catch {
      return undefined; // deleted since: treat as not set up
    }
  }

  /** Creates the demo agent and sellers for this user (once). */
  setup(ownerId: string | null): DemoWorkspace {
    const existing = this.get(ownerId);
    if (existing) return existing;
    const { agent, apiKey } = this.participants.createAgent(
      "Research Agent",
      { dailyLimit: 2_000_000, maxPerRequest: 1_000_000, approvalAbove: 250_000, allowedHosts: [new URL(DEMO_ATLAS).hostname] },
      ownerId,
    );
    const atlas = this.participants.createSeller("Atlas Data", this.config.demo.sellerPaypalEmail || undefined, ownerId).seller;
    const leads = this.participants.createSeller("QuickLeads", undefined, ownerId).seller;
    const ws: DemoWorkspace = { agentId: agent.id, agentKey: apiKey, atlasSellerId: atlas.id, quickLeadsSellerId: leads.id };
    // The demo agent's key is kept so the hub can run it. Agents users create themselves never are.
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(settingKey(ownerId), JSON.stringify(ws));
    return ws;
  }

  status(ownerId: string | null) {
    const ws = this.get(ownerId);
    return {
      ready: Boolean(ws),
      agentId: ws?.agentId,
      atlasSellerId: ws?.atlasSellerId,
      quickLeadsSellerId: ws?.quickLeadsSellerId,
      running: this.running.has(settingKey(ownerId)),
      mode: this.nextMode(ownerId),
      tasks: DEMO_TASKS,
      sources: [DEMO_ATLAS, DEMO_LEADS],
      sandboxBuyer:
        this.config.paypal.mode === "sandbox" && this.config.demo.buyerEmail
          ? { email: this.config.demo.buyerEmail, password: this.config.demo.buyerPassword }
          : undefined,
    };
  }

  /** Starts the research agent in the background. Progress arrives as agent.* events. */
  async run(ownerId: string | null, taskInput?: string): Promise<{ runId: string; mode: "claude" | "replay" }> {
    const ws = this.get(ownerId);
    if (!ws) throw new AppError(409, "demo_not_ready", "Set up the demo first.");
    const key = settingKey(ownerId);
    if (this.running.has(key)) throw new AppError(409, "demo_running", "The agent is already running. Wait for it to finish.");

    const task = (taskInput ?? "").trim().slice(0, MAX_TASK_CHARS) || DEMO_TASKS[0]!;
    const company = COMPANIES.find((c) => task.toLowerCase().includes(c.name.toLowerCase())) ?? COMPANIES[0]!;
    const mode = this.nextMode(ownerId);
    const model = this.modelFactory
      ? this.modelFactory(company)
      : mode === "claude"
        ? claudeModel({ apiKey: this.config.demo.anthropicApiKey, model: this.config.demo.claudeModel, maxTokens: 1500 })
        : replayModel({ atlas: DEMO_ATLAS, leads: DEMO_LEADS, company });
    if (mode === "claude" && !this.modelFactory) this.countClaudeRun(key);

    const apis = await this.startApis();
    const runId = `run_${randomBytes(6).toString("base64url")}`;
    const base = { agentId: ws.agentId, runId };
    const wallet = new TollgateClient({
      hubUrl: this.config.hubUrl,
      agentKey: ws.agentKey,
      fetch: this.routedFetch(ws, apis),
      approvalTimeoutMs: 10 * 60_000,
    });

    this.running.add(key);
    this.events.publish("agent.started", { ...base, task, mode });
    void runResearchAgent({
      task,
      model,
      wallet,
      sources: [DEMO_ATLAS, DEMO_LEADS],
      maxTurns: 14,
      onStep: (step: AgentStep) => this.events.publish("agent.step", { ...base, ...step }),
    })
      .then(({ answer }) => this.events.publish("agent.finished", { ...base, answer }))
      .catch((err: Error) => this.events.publish("agent.failed", { ...base, error: err.message }))
      .finally(() => this.running.delete(key));
    return { runId, mode };
  }

  close() {
    void this.apis?.then((a) => a.close());
  }

  private nextMode(ownerId: string | null): "claude" | "replay" {
    const { anthropicApiKey, claudeModel: model, claudeRunsPerDay } = this.config.demo;
    if (!anthropicApiKey || !model) return "replay";
    this.rollDay();
    const mine = this.claudeRuns.byOwner.get(settingKey(ownerId)) ?? 0;
    return this.claudeRuns.total < claudeRunsPerDay && mine < RUNS_PER_USER_PER_DAY ? "claude" : "replay";
  }

  private countClaudeRun(key: string) {
    this.rollDay();
    this.claudeRuns.total++;
    this.claudeRuns.byOwner.set(key, (this.claudeRuns.byOwner.get(key) ?? 0) + 1);
  }

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (this.claudeRuns.day !== today) this.claudeRuns = { day: today, total: 0, byOwner: new Map() };
  }

  /**
   * The demo agent's only way out. It can reach the two demo sellers and the hub, nothing
   * else, so a prompt can't make the hub fetch arbitrary URLs.
   */
  private routedFetch(ws: DemoWorkspace, apis: { atlas: string; leads: string }): typeof fetch {
    return async (input, init = {}) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
      const headers = new Headers(init.headers);
      const path = `${url.pathname}${url.search}`;
      if (url.origin === DEMO_ATLAS) {
        headers.set(SELLER_HEADER, ws.atlasSellerId);
        return fetch(`${apis.atlas}${path}`, { ...init, headers });
      }
      if (url.origin === DEMO_LEADS) {
        headers.set(SELLER_HEADER, ws.quickLeadsSellerId);
        return fetch(`${apis.leads}${path}`, { ...init, headers });
      }
      if (`${url.origin}` === new URL(this.config.hubUrl).origin) {
        return fetch(`${this.internalHubUrl}${path}`, { ...init, headers });
      }
      throw new Error(`The demo agent can only reach ${DEMO_ATLAS} and ${DEMO_LEADS}`);
    };
  }

  /** Starts Atlas Data and QuickLeads on loopback ports (once). */
  private startApis() {
    this.apis ??= (async () => {
      const sellerFrom = (req: { get(name: string): string | undefined }) => req.get(SELLER_HEADER) ?? "";
      const { atlas, quickLeads } = createDemoApis({
        hubUrl: this.config.hubUrl,
        atlasSellerId: sellerFrom,
        quickLeadsSellerId: sellerFrom,
        atlasBaseUrl: DEMO_ATLAS,
        quickLeadsBaseUrl: DEMO_LEADS,
        // Receipt keys come straight from the hub process instead of over the network.
        fetch: async (input, init) =>
          String(input).endsWith(WELL_KNOWN_PATH) ? Response.json(this.keys()) : fetch(input, init),
      });
      const listen = (app: http.RequestListener) =>
        new Promise<http.Server>((resolve) => {
          const server = http.createServer(app);
          server.listen(0, "127.0.0.1", () => resolve(server));
        });
      const [a, l] = await Promise.all([listen(atlas), listen(quickLeads)]);
      const url = (s: http.Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
      return {
        atlas: url(a),
        leads: url(l),
        close: () => {
          for (const s of [a, l]) {
            s.closeAllConnections();
            s.close();
          }
        },
      };
    })();
    return this.apis;
  }
}

const settingKey = (ownerId: string | null) => `demo:${ownerId ?? "admin"}`;
