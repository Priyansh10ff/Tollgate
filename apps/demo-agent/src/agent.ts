import { TollgatePaymentError, type TollgateClient } from "@tollgate/client";
import { microsToUsd } from "@tollgate/protocol";

/** Minimal shapes of the Claude Messages API that the agent loop needs. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

export interface Message {
  role: "user" | "assistant";
  content: string | unknown[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export type ModelCall = (request: { system: string; messages: Message[]; tools: ToolDef[] }) => Promise<{
  content: ContentBlock[];
  stop_reason: string | null;
}>;

export type AgentStep =
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; name: string; ok: boolean; summary: string };

export const TOOLS: ToolDef[] = [
  {
    name: "fetch_data",
    description:
      "HTTP GET a URL from one of your data sources and return the response body. " +
      "Some endpoints cost money: they are paid automatically from your Tollgate wallet, " +
      "within spending rules set by your owner. Larger payments may pause until your owner approves. " +
      "If a payment is declined, the result explains why: do not retry it.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "Full http(s) URL" } },
      required: ["url"],
    },
  },
  {
    name: "check_wallet",
    description: "See your wallet balance, how much you've spent today, and your spending rules.",
    input_schema: { type: "object", properties: {} },
  },
];

export function systemPrompt(sources: string[]): string {
  return [
    "You are a research agent. You pay for data yourself using a Tollgate wallet funded by your owner.",
    "",
    "Data sources (start with each one's free /v1/catalog endpoint to see what it offers and what it costs):",
    ...sources.map((s) => `- ${s}`),
    "",
    "Rules:",
    "- Every paid request spends your owner's real money. Only buy what the task needs, and never buy the same thing twice.",
    "- Free endpoints cost nothing; use them first.",
    "- If a payment is declined (spending limit, site not allowed, owner said no), don't retry or look for a workaround. Mention it in your answer.",
    "- The data is fictional demo data. Treat it as given.",
    "",
    "Finish with a short brief for your owner: findings, a clear recommendation, and a 'Spent' line listing what you bought and the total.",
  ].join("\n");
}

const MAX_RESULT_CHARS = 6000;

/** Runs the tool-use loop until Claude gives a final answer. */
export async function runResearchAgent(options: {
  task: string;
  model: ModelCall;
  wallet: TollgateClient;
  sources: string[];
  onStep?: (step: AgentStep) => void;
  maxTurns?: number;
}): Promise<{ answer: string; turns: number }> {
  const { model, wallet, sources } = options;
  const emit = (step: AgentStep) => options.onStep?.(step);
  const system = systemPrompt(sources);
  const messages: Message[] = [{ role: "user", content: options.task }];

  for (let turn = 1; turn <= (options.maxTurns ?? 20); turn++) {
    const response = await model({ system, messages, tools: TOOLS });
    messages.push({ role: "assistant", content: response.content });

    const texts = response.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text.trim()).filter(Boolean);
    const toolUses = response.content.filter((b): b is { type: "tool_use"; id: string; name: string; input: unknown } => b.type === "tool_use");

    if (toolUses.length === 0) {
      return { answer: texts.join("\n\n"), turns: turn };
    }
    for (const text of texts) emit({ kind: "thought", text });

    const results = [];
    for (const use of toolUses) {
      const input = (use.input ?? {}) as Record<string, unknown>;
      emit({ kind: "tool_call", name: use.name, input });
      const result = await runTool(use.name, input, wallet);
      emit({ kind: "tool_result", name: use.name, ok: !result.isError, summary: result.text.slice(0, 160) });
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.text, is_error: result.isError });
    }
    messages.push({ role: "user", content: results });
  }
  return { answer: "Stopped: reached the maximum number of steps.", turns: options.maxTurns ?? 20 };
}

async function runTool(name: string, input: Record<string, unknown>, wallet: TollgateClient): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === "fetch_data") {
      const url = String(input.url ?? "");
      if (!/^https?:\/\//i.test(url)) return { text: "url must start with http:// or https://", isError: true };
      const res = await wallet.fetch(url);
      const body = await res.text();
      const clipped = body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}… [truncated]` : body;
      return { text: `HTTP ${res.status}\n${clipped}`, isError: !res.ok };
    }
    if (name === "check_wallet") {
      const w = await wallet.wallet();
      return {
        text: JSON.stringify({
          balanceUsd: microsToUsd(w.balance),
          spentTodayUsd: microsToUsd(w.spentToday),
          rules: {
            dailyLimitUsd: microsToUsd(w.policy.dailyLimit),
            maxPerRequestUsd: microsToUsd(w.policy.maxPerRequest),
            needsOwnerApprovalAboveUsd: microsToUsd(w.policy.approvalAbove),
            allowedHosts: w.policy.allowedHosts.length ? w.policy.allowedHosts : "any",
          },
        }),
        isError: false,
      };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  } catch (err) {
    if (err instanceof TollgatePaymentError) {
      return { text: `Payment declined (${err.code}): ${err.message}. Do not retry this request.`, isError: true };
    }
    return { text: `Request failed: ${(err as Error).message}`, isError: true };
  }
}
