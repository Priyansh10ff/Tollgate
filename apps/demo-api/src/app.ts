import express, { type Request } from "express";
import { tollgate } from "@tollgate/express";
import { COMPANIES, findCompany } from "./data.ts";

export { COMPANIES } from "./data.ts";

type PerRequest<T> = T | ((req: Request) => T);

export interface DemoApiOptions {
  hubUrl: string;
  /** Seller id for Atlas Data, the trustworthy demo API. */
  atlasSellerId: PerRequest<string>;
  /** Seller id for QuickLeads, an unvetted site the demo agent isn't allowed to pay. */
  quickLeadsSellerId: PerRequest<string>;
  /** Public base URLs to put in quotes (when the APIs are reached through a proxy). */
  atlasBaseUrl?: string;
  quickLeadsBaseUrl?: string;
  /** Fetch used to load the hub's receipt keys. */
  fetch?: typeof fetch;
}

interface Endpoint {
  method: "GET";
  path: string;
  price: string | null;
  description: string;
}

/**
 * Two demo sellers:
 *  - Atlas Data: market data on (fictional) companies, priced per request.
 *  - QuickLeads: a "contact list" site. The demo agent's spending rules don't allow it.
 */
export function createDemoApis(options: DemoApiOptions) {
  const gateFor = (sellerId: PerRequest<string>, baseUrl?: string) => (price: string, description: (req: Request) => string) =>
    tollgate({ hubUrl: options.hubUrl, sellerId, price, description, baseUrl, fetch: options.fetch });
  const atlasGate = gateFor(options.atlasSellerId, options.atlasBaseUrl);
  const leadsGate = gateFor(options.quickLeadsSellerId, options.quickLeadsBaseUrl);

  // ── Atlas Data ──────────────────────────────────────────────
  const atlas = express();
  atlas.disable("x-powered-by");
  const atlasCatalog: Endpoint[] = [
    { method: "GET", path: "/v1/catalog", price: null, description: "This list of endpoints and prices" },
    { method: "GET", path: "/v1/companies", price: null, description: "List of covered companies (name, slug, sector)" },
    { method: "GET", path: "/v1/companies/{slug}", price: "0.02", description: "Company profile" },
    { method: "GET", path: "/v1/companies/{slug}/financials", price: "0.05", description: "Latest annual financials" },
    { method: "GET", path: "/v1/news?company={slug}", price: "0.01", description: "Recent news headlines with sentiment" },
    { method: "GET", path: "/v1/reports/{slug}", price: "0.50", description: "Full analyst report: rating, thesis, risks, valuation" },
  ];

  atlas.get("/", (_req, res) => {
    const rows = atlasCatalog.map((e) => `<tr><td><code>${e.method} ${e.path}</code></td><td>${e.price ? `$${e.price}` : "free"}</td><td>${e.description}</td></tr>`).join("");
    res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas Data</title>
      <style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}td{padding:6px 10px;border-bottom:1px solid #ddd}code{font-size:13px}</style>
      <h1>Atlas Data</h1><p>Market data for AI agents, paid per request through <b>Tollgate</b>. All companies are fictional demo data.</p>
      <table>${rows}</table>`);
  });

  atlas.get("/v1/catalog", (_req, res) => {
    res.json({ name: "Atlas Data", description: "Market data on companies, priced per request. Demo data: all companies are fictional.", paidWith: "Tollgate", endpoints: atlasCatalog });
  });

  atlas.get("/v1/companies", (_req, res) => {
    res.json({ companies: COMPANIES.map(({ slug, name, sector }) => ({ slug, name, sector })) });
  });

  const withCompany = (req: Request) => findCompany(String(req.params.slug ?? req.query.company ?? ""));
  const companyName = (req: Request) => withCompany(req)?.name ?? String(req.params.slug ?? req.query.company);

  atlas.get("/v1/companies/:slug", atlasGate("0.02", (req) => `Company profile: ${companyName(req)}`), (req, res) => {
    const c = withCompany(req);
    if (!c) return void res.status(404).json({ error: "Unknown company" });
    const { slug, name, sector, founded, hq, employees, summary } = c;
    res.json({ slug, name, sector, founded, hq, employees, summary });
  });

  atlas.get("/v1/companies/:slug/financials", atlasGate("0.05", (req) => `Financials: ${companyName(req)}`), (req, res) => {
    const c = withCompany(req);
    if (!c) return void res.status(404).json({ error: "Unknown company" });
    res.json({ company: c.name, currency: "USD", ...c.financials, note: "Revenue, income, cash and debt in millions" });
  });

  atlas.get("/v1/news", atlasGate("0.01", (req) => `News: ${companyName(req)}`), (req, res) => {
    const c = withCompany(req);
    if (!c) return void res.status(404).json({ error: "Unknown company. Use ?company={slug}" });
    res.json({ company: c.name, articles: c.news });
  });

  atlas.get("/v1/reports/:slug", atlasGate("0.50", (req) => `Analyst report: ${companyName(req)}`), (req, res) => {
    const c = withCompany(req);
    if (!c) return void res.status(404).json({ error: "Unknown company" });
    res.json({ company: c.name, ...c.report, valuationRangeUsdM: c.report.valuationM, analyst: "Atlas Research (demo)" });
  });

  // ── QuickLeads ──────────────────────────────────────────────
  const quickLeads = express();
  quickLeads.disable("x-powered-by");
  quickLeads.get("/v1/catalog", (_req, res) => {
    res.json({
      name: "QuickLeads",
      description: "Executive contact lists. Unverified third-party data.",
      paidWith: "Tollgate",
      endpoints: [{ method: "GET", path: "/v1/leads?company={slug}", price: "0.40", description: "Direct phone numbers and emails of company executives" }],
    });
  });
  quickLeads.get("/v1/leads", leadsGate("0.40", (req) => `Executive contacts: ${companyName(req)}`), (req, res) => {
    res.json({ company: companyName(req), contacts: [{ name: "(demo)", role: "CEO", email: "ceo@example.com" }] });
  });

  return { atlas, quickLeads };
}
