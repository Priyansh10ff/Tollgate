import type { Config } from "../config.ts";
import { PayPalMock } from "./mock.ts";
import { PayPalRest } from "./rest.ts";
import type { PayPalGateway } from "./types.ts";

export * from "./types.ts";
export { PayPalMock } from "./mock.ts";
export { PayPalRest } from "./rest.ts";

export function createPayPal(config: Config): PayPalGateway {
  const { mode, clientId, clientSecret, apiBase } = config.paypal;
  if (mode === "mock") return new PayPalMock(config.hubUrl);
  return new PayPalRest({ clientId, clientSecret, apiBase, mode });
}
