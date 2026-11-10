/**
 * Fictional demo data. Every company, person and number here is made up.
 */

export interface Company {
  slug: string;
  name: string;
  sector: string;
  founded: number;
  hq: string;
  employees: number;
  summary: string;
  financials: { year: number; revenueM: number; growthPct: number; grossMarginPct: number; netIncomeM: number; cashM: number; debtM: number };
  news: { date: string; headline: string; sentiment: "positive" | "neutral" | "negative" }[];
  report: { rating: "Strong buy" | "Buy" | "Hold" | "Avoid"; thesis: string; risks: string[]; valuationM: [number, number] };
}

export const COMPANIES: Company[] = [
  {
    slug: "northwind-robotics",
    name: "Northwind Robotics",
    sector: "Warehouse automation",
    founded: 2017,
    hq: "Pune, India",
    employees: 640,
    summary: "Builds autonomous picking robots and fleet software for mid-size e-commerce warehouses.",
    financials: { year: 2025, revenueM: 84, growthPct: 61, grossMarginPct: 48, netIncomeM: -6, cashM: 52, debtM: 11 },
    news: [
      { date: "2026-10-28", headline: "Northwind signs 3-year fleet deal with a top-5 Indian grocery chain", sentiment: "positive" },
      { date: "2026-09-14", headline: "Northwind opens second assembly line, doubling robot output", sentiment: "positive" },
      { date: "2026-07-02", headline: "Recall of 120 gripper units after firmware fault, no injuries reported", sentiment: "negative" },
    ],
    report: {
      rating: "Buy",
      thesis: "Category leader in a fast-growing niche; software attach rate rising, path to profitability within 18 months.",
      risks: ["Customer concentration: top 3 customers are 44% of revenue", "Hardware margins sensitive to component prices", "Recent firmware recall"],
      valuationM: [520, 680],
    },
  },
  {
    slug: "helios-grid",
    name: "Helios Grid",
    sector: "Energy storage",
    founded: 2014,
    hq: "Austin, USA",
    employees: 1_250,
    summary: "Makes grid-scale battery systems and the software that trades their stored energy.",
    financials: { year: 2025, revenueM: 310, growthPct: 22, grossMarginPct: 27, netIncomeM: 18, cashM: 140, debtM: 210 },
    news: [
      { date: "2026-10-19", headline: "Helios Grid wins 400 MWh storage tender", sentiment: "positive" },
      { date: "2026-08-08", headline: "Helios Grid refinances debt at higher rates", sentiment: "negative" },
    ],
    report: {
      rating: "Hold",
      thesis: "Solid execution and profitable, but heavily indebted with thin hardware margins.",
      risks: ["High debt load", "Lithium price swings", "Utility procurement cycles are slow"],
      valuationM: [900, 1_150],
    },
  },
  {
    slug: "quanta-foods",
    name: "Quanta Foods",
    sector: "Plant-based food",
    founded: 2019,
    hq: "Amsterdam, Netherlands",
    employees: 210,
    summary: "Produces fermentation-based dairy alternatives for retail and restaurants.",
    financials: { year: 2025, revenueM: 36, growthPct: 9, grossMarginPct: 31, netIncomeM: -14, cashM: 12, debtM: 4 },
    news: [
      { date: "2026-10-03", headline: "Quanta Foods cuts 15% of staff to extend runway", sentiment: "negative" },
      { date: "2026-06-21", headline: "Quanta launches oat-casein cheese in 900 stores", sentiment: "positive" },
    ],
    report: {
      rating: "Avoid",
      thesis: "Slowing growth and under a year of cash; likely needs a down-round.",
      risks: ["Runway under 12 months", "Category demand softening", "Retail shelf-space competition"],
      valuationM: [40, 70],
    },
  },
  {
    slug: "lumen-health",
    name: "Lumen Health",
    sector: "Clinical AI",
    founded: 2020,
    hq: "Bengaluru, India",
    employees: 380,
    summary: "Triage software that reads radiology scans and flags urgent cases for doctors.",
    financials: { year: 2025, revenueM: 47, growthPct: 74, grossMarginPct: 79, netIncomeM: -3, cashM: 61, debtM: 0 },
    news: [
      { date: "2026-10-11", headline: "Lumen Health receives regulatory clearance for chest X-ray triage", sentiment: "positive" },
      { date: "2026-05-30", headline: "Lumen partners with 40 district hospitals", sentiment: "positive" },
    ],
    report: {
      rating: "Strong buy",
      thesis: "High-margin software with regulatory moat and strong hospital adoption.",
      risks: ["Regulatory changes", "Reimbursement uncertainty", "Competition from large imaging vendors"],
      valuationM: [700, 950],
    },
  },
];

export const findCompany = (slug: string) => COMPANIES.find((c) => c.slug === slug.toLowerCase());
