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
      // Summarise what really happened, from the tool results the loop sent back.
      const results = messages
        .filter((m) => m.role === "user" && Array.isArray(m.content))
        .flatMap((m) => m.content as { type?: string; content?: string; is_error?: boolean }[])
        .filter((b) => b.type === "tool_result");
      const bought: string[] = [];
      const failed: string[] = [];
      let blocked = false;
      steps.forEach((s, i) => {
        const r = results[i];
        if (!s.url || !r || s.url.endsWith("/catalog")) return;
        const label = labelFor(s.url);
        if (/policy_host_not_allowed/.test(r.content ?? "")) blocked = true;
        else if (r.is_error) failed.push(label);
        else bought.push(label);
      });
      const lines = [
        `Brief on ${company.name} (replay mode: scripted steps, real payments).`,
        bought.length ? `Bought from Atlas Data: ${bought.join(", ")}.` : "Nothing was bought.",
        failed.length ? `Couldn't get: ${failed.join(", ")} (failed lookups aren't charged).` : "",
        blocked ? "QuickLeads was blocked by your spending rules, so there are no executive contacts. Add it to the allowed sites to change that." : "",
        "Replay mode only runs this fixed investing script. With Claude configured on the hub, the agent answers any question.",
      ];
      return { stop_reason: "end_turn", content: [{ type: "text", text: lines.filter(Boolean).join("\n\n") }] };
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

function labelFor(url: string): string {
  if (url.includes("/financials")) return "annual financials";
  if (url.includes("/reports/")) return "full report";
  if (url.includes("/companies/")) return "company profile";
  if (url.includes("/news")) return "recent news";
  if (url.includes("/leads")) return "executive contacts";
  return url;
}
