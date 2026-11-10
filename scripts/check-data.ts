/**
 * Calls every live data source Atlas Data uses and prints a one-line summary of each.
 *
 *   npm run check-data
 */
import { existsSync } from "node:fs";
import { liveSources } from "@tollgate/demo-api";

if (existsSync(".env")) process.loadEnvFile(".env");

const sources = liveSources();
const checks: [string, () => Promise<unknown>, (v: any) => string][] = [
  ["SEC ticker lookup", () => sources.findCompanies("nvidia"), (v) => v.map((c: any) => `${c.ticker} ${c.name}`).join(", ")],
  ["SEC company profile", () => sources.company("NVDA"), (v) => `${v.name} · ${v.industry} · ${v.headquarters}`],
  ["SEC financials", () => sources.financials("NVDA"), (v) => v.years.map((y: any) => `FY${y.fiscalYearEnding} revenue $${y.revenueM}M, net $${y.netIncomeM}M`).join(" | ")],
  ["SEC filings", () => sources.filings("NVDA"), (v) => v.slice(0, 3).map((f: any) => `${f.form} ${f.filed}`).join(", ")],
  ["Hacker News", () => sources.news("NVIDIA"), (v) => `${v.stories.length} stories, latest: ${v.stories[0]?.title}`],
  ["Wikipedia", () => sources.wiki("Formula One"), (v) => `${v.title}: ${String(v.summary).slice(0, 70)}…`],
  ["Weather", () => sources.weather("Tokyo"), (v) => `${v.place}: ${v.now.temperatureC}°C, ${v.now.conditions}`],
  ["Currency", () => sources.fx("USD", ["INR", "JPY"]), (v) => `${v.date}: 1 USD = ${v.rates.INR} INR, ${v.rates.JPY} JPY`],
  ["F1 standings", () => sources.f1("drivers"), (v) => v.standings.slice(0, 3).map((d: any) => `${d.position}. ${d.driver} ${d.points}`).join(", ")],
  ["F1 next race", () => sources.f1("next-race"), (v) => `${v.race}, ${v.city} on ${v.date}`],
  ["Web page", () => sources.page("https://example.com"), (v) => `${v.title}: ${String(v.text).slice(0, 50)}…`],
];

let failed = 0;
for (const [name, run, show] of checks) {
  try {
    console.log(`\x1b[32m✔\x1b[0m ${name.padEnd(20)} ${show(await run())}`);
  } catch (err) {
    failed++;
    console.log(`\x1b[31m✘\x1b[0m ${name.padEnd(20)} ${(err as Error).message}`);
  }
}
console.log(failed ? `\n${failed} source(s) failed.` : "\nAll live data sources work.");
process.exitCode = failed ? 1 : 0;
