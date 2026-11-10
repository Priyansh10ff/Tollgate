import Anthropic from "@anthropic-ai/sdk";
import type { ModelCall } from "./agent.ts";

/** Connects the agent loop to the Claude Messages API. */
export function claudeModel(options: { apiKey: string; model: string; maxTokens?: number }): ModelCall {
  const client = new Anthropic({ apiKey: options.apiKey });
  return async ({ system, messages, tools }) => {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 2048,
      system,
      tools: tools as Anthropic.Tool[],
      messages: messages as Anthropic.MessageParam[],
    });
    return { content: response.content as never, stop_reason: response.stop_reason };
  };
}
