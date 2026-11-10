import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Real-world data for Atlas Data, fetched live from free public sources:
 * Wikipedia, Open-Meteo, Frankfurter (ECB rates), Hacker News (Algolia),
 * Jolpica (Formula 1), SEC EDGAR (US company filings) and any public web page.
 *
 * Every method throws DataError when there's nothing to sell, so the API can
 * answer 404/502 before asking for payment: agents never pay for a failed lookup.
 */
export interface DataSources {
  wiki(topic: string): Promise<object>;
  weather(city: string): Promise<object>;
  fx(base: string, symbols: string[]): Promise<object>;
  news(query: string): Promise<object>;
  f1(view: F1View): Promise<object>;
  page(url: string): Promise<object>;
  findCompanies(query: string): Promise<{ ticker: string; name: string; cik: number }[]>;
  company(ticker: string): Promise<CompanyProfile>;
  financials(ticker: string): Promise<CompanyFinancials>;
  filings(ticker: string): Promise<object[]>;
}

export type F1View = "drivers" | "teams" | "last-race" | "next-race";

export interface CompanyProfile {
  ticker: string;
  name: string;
  cik: number;
  industry: string;
  exchanges: string[];
  headquarters: string;
  fiscalYearEnd: string;
  filerCategory: string;
  about?: string;
  source: string;
}

export interface CompanyFinancials {
  ticker: string;
  name: string;
  currency: "USD";
  unit: "millions";
  years: Record<string, number | null | string>[];
  source: string;
}

export class DataError extends Error {
  constructor(
    public status: 400 | 404 | 502,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 8000;

export function liveSources(options: { userAgent?: string } = {}): DataSources {
  // SEC EDGAR only answers clients that identify themselves with a name and contact email,
  // e.g. SEC_USER_AGENT="Tollgate demo you@example.com".
  const userAgent = options.userAgent ?? (process.env.SEC_USER_AGENT?.trim() || "Tollgate demo (https://github.com/Priyansh10ff/Tollgate)");
  const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

  /** Caches successful lookups; failures are retried next time. */
  function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
    const value = load();
    cache.set(key, { expires: Date.now() + ttlMs, value });
    value.catch(() => cache.delete(key));
    if (cache.size > 2000) for (const [k, v] of cache) if (v.expires < Date.now()) cache.delete(k);
    return value;
  }

  async function getJson<T = any>(url: string, what: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new DataError(502, `${what} is not responding right now`);
    }
    if (res.status === 404) throw new DataError(404, `${what}: not found`);
    if (res.status === 403 && what === "SEC EDGAR") {
      throw new DataError(502, 'SEC EDGAR refused the request. The hub needs SEC_USER_AGENT set to a name and contact email, e.g. "Tollgate demo you@example.com".');
    }
    if (!res.ok) throw new DataError(502, `${what} answered ${res.status}`);
    return (await res.json()) as T;
  }

  const MIN = 60_000;

  // ── SEC EDGAR ────────────────────────────────────────────────
  const tickerMap = () =>
    cached("sec:tickers", 24 * 60 * MIN, async () => {
      const raw = await getJson<Record<string, { cik_str: number; ticker: string; title: string }>>("https://www.sec.gov/files/company_tickers.json", "SEC EDGAR");
      return Object.values(raw).map((r) => ({ ticker: r.ticker.toUpperCase(), name: r.title, cik: r.cik_str }));
    });

  async function cikFor(ticker: string) {
    const t = ticker.trim().toUpperCase();
    const hit = (await tickerMap()).find((c) => c.ticker === t);
    if (!hit) throw new DataError(404, `No US-listed company with ticker ${t}. Use /v1/companies?q=name to look one up.`);
    return hit;
  }
  const cik10 = (cik: number) => String(cik).padStart(10, "0");
  const submissions = (cik: number) => cached(`sec:sub:${cik}`, 60 * MIN, () => getJson(`https://data.sec.gov/submissions/CIK${cik10(cik)}.json`, "SEC EDGAR"));

  const sources: DataSources = {
    async wiki(topic) {
      const q = topic.trim();
      if (!q) throw new DataError(400, "Pass ?topic=");
      return cached(`wiki:${q.toLowerCase()}`, 60 * MIN, async () => {
        const search = await getJson<{ pages: { key: string }[] }>(
          `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=1`,
          "Wikipedia",
        );
        const key = search.pages[0]?.key;
        if (!key) throw new DataError(404, `Wikipedia has no article for "${q}"`);
        const s = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(key)}`, "Wikipedia");
        return {
          title: s.title,
          description: s.description,
          summary: s.extract,
          url: s.content_urls?.desktop?.page,
          lastEdited: s.timestamp,
          source: "Wikipedia (CC BY-SA)",
        };
      });
    },

    async weather(city) {
      const q = city.trim();
      if (!q) throw new DataError(400, "Pass ?city=");
      return cached(`wx:${q.toLowerCase()}`, 15 * MIN, async () => {
        const geo = await getJson<{ results?: any[] }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`, "Open-Meteo");
        const place = geo.results?.[0];
        if (!place) throw new DataError(404, `Couldn't find a place called "${q}"`);
        const f = await getJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
            "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
            "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7",
          "Open-Meteo",
        );
        return {
          place: [place.name, place.admin1, place.country].filter(Boolean).join(", "),
          timezone: f.timezone,
          now: {
            time: f.current.time,
            temperatureC: f.current.temperature_2m,
            feelsLikeC: f.current.apparent_temperature,
            humidityPct: f.current.relative_humidity_2m,
            windKmh: f.current.wind_speed_10m,
            conditions: weatherText(f.current.weather_code),
          },
          next7Days: f.daily.time.map((day: string, i: number) => ({
            date: day,
            conditions: weatherText(f.daily.weather_code[i]),
            highC: f.daily.temperature_2m_max[i],
            lowC: f.daily.temperature_2m_min[i],
            rainChancePct: f.daily.precipitation_probability_max[i],
          })),
          source: "Open-Meteo",
        };
      });
    },

    async fx(base, symbols) {
      const b = base.trim().toUpperCase() || "USD";
      if (!/^[A-Z]{3}$/.test(b) || symbols.some((s) => !/^[A-Z]{3}$/.test(s))) throw new DataError(400, "Use 3-letter currency codes, e.g. ?base=USD&symbols=INR,EUR");
      const to = symbols.length ? `&symbols=${symbols.join(",")}` : "";
      return cached(`fx:${b}:${symbols.join(",")}`, 30 * MIN, async () => {
        const r = await getJson(`https://api.frankfurter.dev/v1/latest?base=${b}${to}`, "Frankfurter");
        return { base: r.base, date: r.date, rates: r.rates, source: "Frankfurter (European Central Bank reference rates)" };
      });
    },

    async news(query) {
      const q = query.trim();
      if (!q) throw new DataError(400, "Pass ?q=");
      return cached(`news:${q.toLowerCase()}`, 15 * MIN, async () => {
        const since = Math.floor(Date.now() / 1000) - 365 * 86400;
        const r = await getJson<{ hits: any[] }>(
          `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=10&numericFilters=created_at_i>${since}`,
          "Hacker News search",
        );
        return {
          query: q,
          stories: r.hits.map((h) => ({
            title: h.title,
            url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
            date: String(h.created_at).slice(0, 10),
            points: h.points,
            comments: h.num_comments,
            discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
          })),
          source: "Hacker News via Algolia, stories from the past year",
        };
      });
    },

    async f1(view) {
      const paths: Record<F1View, string> = {
        drivers: "current/driverStandings.json",
        teams: "current/constructorStandings.json",
        "last-race": "current/last/results.json",
        "next-race": "current/next.json",
      };
      if (!paths[view]) throw new DataError(400, "view must be drivers, teams, last-race or next-race");
      return cached(`f1:${view}`, 30 * MIN, async () => {
        const r = (await getJson(`https://api.jolpi.ca/ergast/f1/${paths[view]}`, "Jolpica F1")).MRData;
        const source = "Jolpica F1 API (Ergast-compatible)";
        if (view === "drivers" || view === "teams") {
          const list = r.StandingsTable.StandingsLists[0];
          if (!list) throw new DataError(404, "No standings published yet this season");
          return {
            season: list.season,
            afterRound: list.round,
            standings:
              view === "drivers"
                ? list.DriverStandings.map((d: any) => ({
                    position: Number(d.position),
                    driver: `${d.Driver.givenName} ${d.Driver.familyName}`,
                    team: d.Constructors.at(-1)?.name,
                    points: Number(d.points),
                    wins: Number(d.wins),
                  }))
                : list.ConstructorStandings.map((c: any) => ({ position: Number(c.position), team: c.Constructor.name, points: Number(c.points), wins: Number(c.wins) })),
            source,
          };
        }
        const race = r.RaceTable.Races[0];
        if (!race) throw new DataError(404, view === "next-race" ? "No upcoming race this season" : "No race results yet");
        const where = { circuit: race.Circuit.circuitName, city: race.Circuit.Location.locality, country: race.Circuit.Location.country };
        if (view === "next-race") {
          return { season: race.season, round: Number(race.round), race: race.raceName, ...where, date: race.date, startsUtc: race.time ? `${race.date}T${race.time}` : race.date, source };
        }
        return {
          season: race.season,
          round: Number(race.round),
          race: race.raceName,
          ...where,
          date: race.date,
          results: race.Results.slice(0, 10).map((x: any) => ({
            position: Number(x.position),
            driver: `${x.Driver.givenName} ${x.Driver.familyName}`,
            team: x.Constructor.name,
            points: Number(x.points),
            status: x.status,
          })),
          source,
        };
      });
    },

    page: (url) => readPage(url, userAgent),

    async findCompanies(query) {
      const q = query.trim().toLowerCase();
      if (!q) throw new DataError(400, "Pass ?q= with a company name or ticker");
      const all = await tickerMap();
      const exact = all.filter((c) => c.ticker.toLowerCase() === q);
      const byName = all.filter((c) => c.name.toLowerCase().includes(q) && !exact.includes(c));
      return [...exact, ...byName].slice(0, 8);
    },

    async company(ticker) {
      const hit = await cikFor(ticker);
      const s = await submissions(hit.cik);
      const addr = s.addresses?.business ?? s.addresses?.mailing ?? {};
      let about: string | undefined;
      try {
        about = String(((await sources.wiki(`${hit.name} company`)) as { summary?: string }).summary ?? "") || undefined;
      } catch {
        // The SEC profile is enough on its own.
      }
      return {
        ticker: hit.ticker,
        name: s.name,
        cik: hit.cik,
        industry: s.sicDescription,
        exchanges: s.exchanges,
        headquarters: [addr.city, addr.stateOrCountryDescription].filter(Boolean).join(", "),
        fiscalYearEnd: s.fiscalYearEnd ? `${s.fiscalYearEnd.slice(0, 2)}-${s.fiscalYearEnd.slice(2)}` : "",
        filerCategory: s.category,
        about,
        source: "SEC EDGAR, with Wikipedia",
      };
    },

    async financials(ticker) {
      const hit = await cikFor(ticker);
      return cached(`sec:fin:${hit.cik}`, 6 * 60 * MIN, async () => {
        const facts = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik10(hit.cik)}.json`, "SEC EDGAR");
        const gaap = facts.facts?.["us-gaap"] ?? {};
        // Latest value per fiscal year from annual reports (10-K), first concept that has data.
        const annual = (concepts: string[], unit = "USD") => {
          for (const c of concepts) {
            const rows: any[] = gaap[c]?.units?.[unit] ?? [];
            const fy = new Map<number, number>();
            for (const r of rows) {
              if (r.form !== "10-K" || r.fp !== "FY") continue;
              // Duration facts: keep only full-year periods.
              if (r.start && (Date.parse(r.end) - Date.parse(r.start)) / 86_400_000 < 300) continue;
              const year = Number(String(r.end).slice(0, 4));
              fy.set(year, r.val);
            }
            if (fy.size) return fy;
          }
          return new Map<number, number>();
        };
        const series = {
          revenue: annual(["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"]),
          grossProfit: annual(["GrossProfit"]),
          operatingIncome: annual(["OperatingIncomeLoss"]),
          netIncome: annual(["NetIncomeLoss", "ProfitLoss"]),
          cash: annual(["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"]),
          totalAssets: annual(["Assets"]),
          totalLiabilities: annual(["Liabilities"]),
          longTermDebt: annual(["LongTermDebtNoncurrent", "LongTermDebt"]),
        };
        const eps = annual(["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares");
        const years = [...series.revenue.keys(), ...series.netIncome.keys()].sort((a, b) => b - a);
        const recent = [...new Set(years)].slice(0, 3);
        if (!recent.length) throw new DataError(404, `${hit.name} has no annual financials in SEC filings`);
        const m = (v: number | undefined) => (v === undefined ? null : Math.round(v / 1e5) / 10);
        return {
          ticker: hit.ticker,
          name: facts.entityName ?? hit.name,
          currency: "USD",
          unit: "millions",
          years: recent.map((year) => {
            const row: Record<string, number | null | string> = { fiscalYearEnding: String(year) };
            for (const [k, s] of Object.entries(series)) row[`${k}M`] = m(s.get(year));
            row.dilutedEps = eps.get(year) ?? null;
            return row;
          }),
          source: "SEC EDGAR XBRL company facts (annual 10-K filings)",
        };
      });
    },

    async filings(ticker) {
      const hit = await cikFor(ticker);
      const s = await submissions(hit.cik);
      const r = s.filings.recent;
      const wanted = new Set(["10-K", "10-Q", "8-K", "20-F", "6-K"]);
      const out: object[] = [];
      for (let i = 0; i < r.form.length && out.length < 8; i++) {
        if (!wanted.has(r.form[i])) continue;
        const accession = String(r.accessionNumber[i]).replace(/-/g, "");
        out.push({
          form: r.form[i],
          filed: r.filingDate[i],
          period: r.reportDate[i] || undefined,
          items: r.items?.[i] || undefined,
          url: `https://www.sec.gov/Archives/edgar/data/${hit.cik}/${accession}/${r.primaryDocument[i]}`,
        });
      }
      return out;
    },
  };
  return sources;
}

// ── Reading a public web page safely ───────────────────────────

const MAX_PAGE_BYTES = 1_000_000;
const MAX_PAGE_CHARS = 6000;

/** True for addresses an outside caller must never make us reach (loopback, private, link-local, metadata). */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true;
}

async function assertPublic(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new DataError(400, "Only http and https pages can be read");
  if (url.username || url.password) throw new DataError(400, "URLs with credentials aren't allowed");
  if (url.port && !["80", "443"].includes(url.port)) throw new DataError(400, "Only standard web ports (80, 443) are allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new DataError(400, "That address isn't public");
  }
  let addresses: { address: string }[];
  try {
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  } catch {
    throw new DataError(404, `Couldn't find ${host}`);
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) throw new DataError(400, "That address isn't public");
}

async function readPage(raw: string, userAgent: string): Promise<object> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DataError(400, "Pass a full URL, e.g. ?url=https://example.com/article");
  }
  let res: Response | undefined;
  // Follow up to 3 redirects by hand so every hop is checked.
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(url);
    try {
      res = await fetch(url, { redirect: "manual", headers: { "User-Agent": userAgent, Accept: "text/html,text/plain,application/json;q=0.9" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new DataError(502, `${url.hostname} is not responding`);
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) break;
    await res.body?.cancel();
    url = new URL(location, url);
    if (hop === 3) throw new DataError(502, "Too many redirects");
  }
  if (!res || !res.ok) throw new DataError(res?.status === 404 ? 404 : 502, `${url.hostname} answered ${res?.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|text\/plain|application\/json|application\/xhtml/.test(type)) {
    await res.body?.cancel();
    throw new DataError(400, `Can't read ${type || "that kind of"} content`);
  }

  // Read at most 1 MB.
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const body = new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_PAGE_BYTES));

  const isHtml = /html/.test(type);
  const title = isHtml ? decode(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "") : "";
  const text = isHtml ? htmlToText(body) : body.replace(/\s+/g, " ").trim();
  return {
    url: url.toString(),
    title: title || undefined,
    text: text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}… [truncated]` : text,
    fetchedAt: new Date().toISOString(),
  };
}

function htmlToText(html: string): string {
  const main = html.match(/<(main|article)[\s\S]*?<\/\1>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  return decode(
    main
      .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decode(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return named[e.toLowerCase()] ?? m;
  });
}

const WMO: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Freezing fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Rain showers",
  82: "Violent rain showers", 85: "Snow showers", 86: "Heavy snow showers", 95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with hail",
};
const weatherText = (code: number) => WMO[code] ?? `Weather code ${code}`;
