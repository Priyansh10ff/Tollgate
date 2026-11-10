import express, { type NextFunction, type Request, type Response } from "express";
import { tollgate } from "@tollgate/express";
import { DataError, liveSources, type DataSources, type F1View } from "./live.ts";

export { liveSources, DataError, isPrivateAddress, type DataSources } from "./live.ts";
export { fixtureSources } from "./fixtures.ts";

type PerRequest<T> = T | ((req: Request) => T);

export interface DemoApiOptions {
  hubUrl: string;
  /** Seller id for Atlas Data, the real-world data API. */
  atlasSellerId: PerRequest<string>;
  /** Seller id for QuickLeads, an unvetted site the demo agent isn't allowed to pay. */
  quickLeadsSellerId: PerRequest<string>;
  /** Public base URLs to put in quotes (when the APIs are reached through a proxy). */
  atlasBaseUrl?: string;
  quickLeadsBaseUrl?: string;
  /** Fetch used to load the hub's receipt keys. */
  fetch?: typeof fetch;
  /** Where the data comes from. Defaults to live public sources; tests pass fixtures. */
  sources?: DataSources;
}

interface Endpoint {
  method: "GET";
  path: string;
  price: string | null;
  description: string;
}

const CATALOG: Endpoint[] = [
  { method: "GET", path: "/v1/catalog", price: null, description: "This list of endpoints and prices" },
  { method: "GET", path: "/v1/companies?q={name}", price: null, description: "Find a US-listed company's ticker by name" },
  { method: "GET", path: "/v1/companies/{ticker}", price: "0.02", description: "Company profile from SEC filings (industry, HQ, exchanges, about)" },
  { method: "GET", path: "/v1/companies/{ticker}/financials", price: "0.05", description: "Last 3 years of annual financials from 10-K filings (revenue, profit, cash, debt, EPS)" },
  { method: "GET", path: "/v1/news?q={query}", price: "0.01", description: "Recent tech news and discussion (Hacker News, past year)" },
  { method: "GET", path: "/v1/reports/{ticker}", price: "0.50", description: "Full company report: financial trends and margins, latest SEC filings, recent news" },
  { method: "GET", path: "/v1/wiki?topic={topic}", price: "0.01", description: "Encyclopedia summary of any topic (Wikipedia)" },
  { method: "GET", path: "/v1/weather?city={city}", price: "0.01", description: "Current weather and 7-day forecast for any city" },
  { method: "GET", path: "/v1/fx?base=USD&symbols=INR,EUR", price: "0.01", description: "Latest currency exchange rates (ECB reference rates)" },
  { method: "GET", path: "/v1/f1?view=drivers|teams|last-race|next-race", price: "0.02", description: "Live Formula 1 standings, last race results, next race" },
  { method: "GET", path: "/v1/page?url={url}", price: "0.03", description: "Read any public web page as plain text" },
];

/**
 * Two demo sellers:
 *  - Atlas Data: live real-world data (companies, news, weather, currencies, F1, any web page), priced per request.
 *  - QuickLeads: a "contact list" site. The demo agent's spending rules don't allow it.
 */
export function createDemoApis(options: DemoApiOptions) {
  const sources = options.sources ?? liveSources();
  const gateFor = (sellerId: PerRequest<string>, baseUrl?: string) => (price: string, description: (req: Request) => string) =>
    tollgate({ hubUrl: options.hubUrl, sellerId, price, description, baseUrl, fetch: options.fetch });
  const atlasGate = gateFor(options.atlasSellerId, options.atlasBaseUrl);
  const leadsGate = gateFor(options.quickLeadsSellerId, options.quickLeadsBaseUrl);

  /**
   * Looks the data up before the paywall, so a request that can't be answered
   * (unknown ticker, source down) gets an error and is never charged.
   */
  const load = (fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.data = await fn(req);
      next();
    } catch (err) {
      if (err instanceof DataError) return void res.status(err.status).json({ error: err.message, charged: false });
      next(err);
    }
  };
  const send = (_req: Request, res: Response) => void res.json(res.locals.data);
  const q = (req: Request, name: string) => String(req.query[name] ?? "").slice(0, 300);
  const ticker = (req: Request) => String(req.params.ticker ?? "").toUpperCase().slice(0, 12);

  // ── Atlas Data ──────────────────────────────────────────────
  const atlas = express();
  atlas.disable("x-powered-by");

  atlas.get("/", (_req, res) => {
    const rows = CATALOG.map((e) => `<tr><td><code>${e.method} ${e.path}</code></td><td>${e.price ? `$${e.price}` : "free"}</td><td>${e.description}</td></tr>`).join("");
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas Data</title>
      <style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 16px}td{padding:6px 10px;border-bottom:1px solid #ddd}code{font-size:13px}</style>
      <h1>Atlas Data</h1><p>Live real-world data for AI agents, paid per request through <b>Tollgate</b>.</p>
      <table>${rows}</table>`);
  });

  atlas.get("/v1/catalog", (_req, res) => {
    res.json({
      name: "Atlas Data",
      description:
        "Live real-world data, priced per request: US company profiles, financials and filings (SEC EDGAR), tech news, " +
        "encyclopedia summaries, weather, currency rates, Formula 1, and any public web page. Failed lookups are never charged.",
      paidWith: "Tollgate",
      endpoints: CATALOG,
    });
  });

  atlas.get(
    "/v1/companies",
    load((req) => sources.findCompanies(q(req, "q"))),
    (_req, res) => void res.json({ matches: res.locals.data }),
  );

  atlas.get(
    "/v1/companies/:ticker",
    load((req) => sources.company(ticker(req))),
    atlasGate("0.02", (req) => `Company profile: ${ticker(req)}`),
    send,
  );

  atlas.get(
    "/v1/companies/:ticker/financials",
    load((req) => sources.financials(ticker(req))),
    atlasGate("0.05", (req) => `Financials: ${ticker(req)}`),
    send,
  );

  atlas.get(
    "/v1/news",
    load((req) => sources.news(q(req, "q") || q(req, "company"))),
    atlasGate("0.01", (req) => `News: ${q(req, "q") || q(req, "company")}`),
    send,
  );

  atlas.get(
    "/v1/reports/:ticker",
    load(async (req) => {
      const t = ticker(req);
      const [profile, financials, filings] = await Promise.all([sources.company(t), sources.financials(t), sources.filings(t)]);
      const news = await sources.news(profile.name.replace(/\b(CORP|INC|CO|LTD|PLC|HOLDINGS?)\b\.?/gi, "").trim()).catch(() => null);
      return { ...profile, analysis: analyse(financials.years), financials: financials.years, latestFilings: filings, news, sources: ["SEC EDGAR", "Hacker News", "Wikipedia"] };
    }),
    atlasGate("0.50", (req) => `Full report: ${ticker(req)}`),
    send,
  );

  atlas.get("/v1/wiki", load((req) => sources.wiki(q(req, "topic") || q(req, "q"))), atlasGate("0.01", (req) => `Encyclopedia: ${q(req, "topic") || q(req, "q")}`), send);

  atlas.get("/v1/weather", load((req) => sources.weather(q(req, "city"))), atlasGate("0.01", (req) => `Weather: ${q(req, "city")}`), send);

  atlas.get(
    "/v1/fx",
    load((req) => sources.fx(q(req, "base") || "USD", q(req, "symbols").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean))),
    atlasGate("0.01", (req) => `Exchange rates: ${(q(req, "base") || "USD").toUpperCase()}`),
    send,
  );

  atlas.get(
    "/v1/f1",
    load((req) => sources.f1((q(req, "view") || "drivers") as F1View)),
    atlasGate("0.02", (req) => `F1 ${q(req, "view") || "drivers"}`),
    send,
  );

  atlas.get(
    "/v1/page",
    load((req) => sources.page(q(req, "url"))),
    atlasGate("0.03", (req) => `Web page: ${hostOf(q(req, "url"))}`),
    send,
  );

  // ── QuickLeads ──────────────────────────────────────────────
  const quickLeads = express();
  quickLeads.disable("x-powered-by");
  quickLeads.get("/v1/catalog", (_req, res) => {
    res.json({
      name: "QuickLeads",
      description: "Executive contact lists. Unverified third-party data.",
      paidWith: "Tollgate",
      endpoints: [{ method: "GET", path: "/v1/leads?company={name or ticker}", price: "0.40", description: "Direct phone numbers and emails of company executives" }],
    });
  });
  const leadsFor = (req: Request) => q(req, "company") || "company";
  quickLeads.get("/v1/leads", leadsGate("0.40", (req) => `Executive contacts: ${leadsFor(req)}`), (req, res) => {
    res.json({ company: leadsFor(req), contacts: [{ name: "(demo)", role: "CEO", email: "ceo@example.com" }] });
  });

  return { atlas, quickLeads };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "page";
  }
};

/** Plain arithmetic over the filed numbers: growth, margins and balance-sheet ratios. */
function analyse(years: Record<string, number | null | string>[]) {
  const [latest, prior] = years;
  if (!latest) return {};
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  const pct = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? Math.round(((a - b) / Math.abs(b)) * 1000) / 10 : null);
  const ratio = (a: number | null, b: number | null) => (a !== null && b !== null && b !== 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    fiscalYear: latest.fiscalYearEnding,
    revenueGrowthPct: pct(n(latest.revenueM), n(prior?.revenueM)),
    netIncomeGrowthPct: pct(n(latest.netIncomeM), n(prior?.netIncomeM)),
    grossMarginPct: ratio(n(latest.grossProfitM), n(latest.revenueM)),
    operatingMarginPct: ratio(n(latest.operatingIncomeM), n(latest.revenueM)),
    netMarginPct: ratio(n(latest.netIncomeM), n(latest.revenueM)),
    liabilitiesToAssetsPct: ratio(n(latest.totalLiabilitiesM), n(latest.totalAssetsM)),
    note: "Computed from the company's own SEC filings. Not investment advice.",
  };
}
