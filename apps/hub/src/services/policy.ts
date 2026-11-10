import { microsToUsd } from "@tollgate/protocol";
import type { AgentPolicy } from "./participants.ts";

export type PolicyDecision =
  | { action: "allow" }
  | { action: "approve"; reason: string }
  | { action: "deny"; code: string; reason: string };

export interface PolicyInput {
  policy: AgentPolicy;
  price: number;
  host: string;
  spentToday: number;
}

/**
 * The owner's spending rules, checked on the hub for every payment.
 * Agents can't skip them: the hub is the only one that can move money.
 */
export function evaluatePolicy({ policy, price, host, spentToday }: PolicyInput): PolicyDecision {
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.some((allowed) => hostMatches(host, allowed))) {
    return { action: "deny", code: "policy_host_not_allowed", reason: `${host} is not on this agent's allowed list` };
  }
  if (price > policy.maxPerRequest) {
    return {
      action: "deny",
      code: "policy_max_per_request",
      reason: `$${microsToUsd(price)} is above the $${microsToUsd(policy.maxPerRequest)} per-request limit`,
    };
  }
  if (spentToday + price > policy.dailyLimit) {
    return {
      action: "deny",
      code: "policy_daily_limit",
      reason: `Would exceed the $${microsToUsd(policy.dailyLimit)} daily limit ($${microsToUsd(spentToday)} spent today)`,
    };
  }
  if (price > policy.approvalAbove) {
    return { action: "approve", reason: `$${microsToUsd(price)} is above the $${microsToUsd(policy.approvalAbove)} auto-approve limit` };
  }
  return { action: "allow" };
}

/** "api.example.com" matches itself; "*.example.com" matches any subdomain. Ports are ignored. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const p = pattern.toLowerCase().replace(/:\d+$/, "");
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}
