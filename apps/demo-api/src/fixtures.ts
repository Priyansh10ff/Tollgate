import { DataError, type CompanyProfile, type CompanyFinancials, type DataSources } from "./live.ts";

/**
 * Offline stand-in for the live sources, for tests. Shapes match liveSources();
 * the numbers are rounded examples, not live data.
 */
export function fixtureSources(): DataSources {
  const companies: Record<string, CompanyProfile> = {
    NVDA: {
      ticker: "NVDA",
      name: "NVIDIA CORP",
      cik: 1045810,
      industry: "Semiconductors & Related Devices",
      exchanges: ["Nasdaq"],
      headquarters: "Santa Clara, CA",
      fiscalYearEnd: "01-31",
      filerCategory: "Large accelerated filer",
      about: "Nvidia Corporation is an American multinational technology company headquartered in Santa Clara, California.",
      source: "SEC EDGAR, with Wikipedia",
    },
  };
  const company = (ticker: string) => {
    const c = companies[ticker.toUpperCase()];
    if (!c) throw new DataError(404, `No US-listed company with ticker ${ticker.toUpperCase()}.`);
    return c;
  };
  return {
    async wiki(topic) {
      return { title: topic, summary: `Summary of ${topic}.`, source: "Wikipedia (CC BY-SA)" };
    },
    async weather(city) {
      if (city.toLowerCase() === "atlantis") throw new DataError(404, `Couldn't find a place called "${city}"`);
      return { place: city, now: { temperatureC: 18, conditions: "Partly cloudy" }, next7Days: [], source: "Open-Meteo" };
    },
    async fx(base, symbols) {
      return { base, date: "2026-11-10", rates: Object.fromEntries(symbols.map((s) => [s, 1.5])), source: "Frankfurter" };
    },
    async news(query) {
      return { query, stories: [{ title: `${query} ships a new GPU architecture`, date: "2026-11-01", points: 512 }], source: "Hacker News via Algolia" };
    },
    async f1(view) {
      return { view, season: "2026", standings: [{ position: 1, driver: "Example Driver", points: 300 }], source: "Jolpica F1 API" };
    },
    async page(url) {
      return { url, title: "Example page", text: "Hello from a public page." };
    },
    async findCompanies(query) {
      return Object.values(companies)
        .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()) || c.ticker === query.toUpperCase())
        .map(({ ticker, name, cik }) => ({ ticker, name, cik }));
    },
    async company(ticker) {
      return company(ticker);
    },
    async financials(ticker): Promise<CompanyFinancials> {
      const c = company(ticker);
      return {
        ticker: c.ticker,
        name: c.name,
        currency: "USD",
        unit: "millions",
        years: [
          { fiscalYearEnding: "2026", revenueM: 130497, grossProfitM: 97858, operatingIncomeM: 81453, netIncomeM: 72880, totalAssetsM: 111601, totalLiabilitiesM: 32274 },
          { fiscalYearEnding: "2025", revenueM: 60922, grossProfitM: 44301, operatingIncomeM: 32972, netIncomeM: 29760, totalAssetsM: 65728, totalLiabilitiesM: 22750 },
        ],
        source: "SEC EDGAR XBRL company facts (annual 10-K filings)",
      };
    },
    async filings(ticker) {
      company(ticker);
      return [{ form: "10-Q", filed: "2026-08-27", url: "https://www.sec.gov/Archives/edgar/data/1045810/example.htm" }];
    },
  };
}
