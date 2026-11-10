import type { ContentBlock, ModelCall } from "./agent.ts";

/**
 * A stand-in for Claude that makes the same calls a careful research agent would,
 * in a fixed order. Used by the hosted demo when no Claude key is configured or the
 * daily Claude budget is used up. Payments, approvals and blocks still go through
 * the real Tollgate flow; only the reasoning is scripted.
 */
export function replayModel(options: { atlas: string; leads: string; company: { ticker: string; name: string } }): ModelCall {
  const { atlas, leads, company } = options;
  const steps: { say: string; url?: string; tool?: "check_wallet" }[] = [
    { say: "Starting with the free catalogs to see what each source offers and costs.", url: `${atlas}/v1/catalog` },
    { say: "", url: `${leads}/v1/catalog` },
    { say: "Checking my budget before buying anything.", tool: "check_wallet" },
    { say: `Buying the essentials on ${company.name}: profile, financials and news.`, url: `${atlas}/v1/companies/${company.ticker}` },
    { say: "", url: `${atlas}/v1/companies/${company.ticker}/financials` },
    { say: "", url: `${atlas}/v1/news?q=${encodeURIComponent(company.name)}` },
    { say: "The full report is the key input for a recommendation. It costs $0.50, so my owner has to approve it.", url: `${atlas}/v1/reports/${company.ticker}` },
    { say: "Now the executive contacts from QuickLeads.", url: `${leads}/v1/leads?company=${company.ticker}` },
  ];
  let id = 0;
  return async ({ messages }) => {
    const turn = messages.filter((m) => m.role === "assistant").length;
    const step = steps[turn];
    if (!step) {
      return {
        stop_reason: "end_turn",
        content: [
          {
            type: "text",
            text:
              `Brief on ${company.name} (replay mode: scripted steps, real payments).\n\n` +
              "I bought the company profile, annual financials and recent news from Atlas Data (live SEC and news data), and the full report after you approved it. " +
              "QuickLeads was blocked by your spending rules, so I didn't get executive contacts: you'd need to add it to the allowed sites first.\n\n" +
              "Spent: profile $0.02, financials $0.05, news $0.01, full report $0.50. Total $0.58. (Replay mode follows a fixed investing script; switch to Claude for open-ended questions.)",
          },
        ],
      };
    }
    const content: ContentBlock[] = [];
    if (step.say) content.push({ type: "text", text: step.say });
    content.push({
      type: "tool_use",
      id: `replay_${++id}`,
      name: step.tool ?? "fetch_data",
      input: step.tool ? {} : { url: step.url },
    });
    return { stop_reason: "tool_use", content };
  };
}
