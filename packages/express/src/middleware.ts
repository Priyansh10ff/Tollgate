import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  PRICE_HEADER,
  PROTOCOL_VERSION,
  RECEIPT_HEADER,
  ReceiptError,
  resourceOf,
  usdToMicros,
  type PaymentRequiredBody,
  type Quote,
  type ReceiptClaims,
} from "@tollgate/protocol";
import { ReceiptVerifier, type ReplayStore } from "./verifier.ts";

type Dynamic<T> = T | ((req: Request) => T);

export interface TollgateOptions {
  /** URL of the Tollgate hub that collects payments for you. */
  hubUrl: string;
  /** Your seller id on that hub. */
  sellerId: string;
  /** Price in USD, e.g. "0.03". Return null from a function to make a request free. */
  price: Dynamic<string | null>;
  /** Shown to the agent's owner, e.g. "Company profile lookup". */
  description?: Dynamic<string | undefined>;
  replayStore?: ReplayStore;
  /** Inject a fetch implementation (tests). */
  fetch?: typeof fetch;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set when the request was paid for. */
    tollgate?: ReceiptClaims;
  }
}

/**
 * Charges AI agents for requests.
 *
 *   app.get("/v1/report", tollgate({ hubUrl, sellerId, price: "0.03" }), handler)
 *
 * Requests without a valid receipt get 402 Payment Required with a quote.
 * Requests with a valid, unused receipt for this exact resource and price go through,
 * with the payment details on req.tollgate.
 */
export function tollgate(options: TollgateOptions): RequestHandler {
  const verifier = new ReceiptVerifier({
    hubUrl: options.hubUrl,
    sellerId: options.sellerId,
    replayStore: options.replayStore,
    fetch: options.fetch,
  });
  const resolve = <T>(value: Dynamic<T>, req: Request): T =>
    typeof value === "function" ? (value as (req: Request) => T)(req) : value;

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const price = resolve(options.price, req);
      if (price === null) return next();
      const priceMicros = usdToMicros(price);
      const resource = resourceOf(req.method, req.originalUrl);

      const token = req.get(RECEIPT_HEADER);
      let receiptError: PaymentRequiredBody["receiptError"];
      if (token) {
        try {
          req.tollgate = await verifier.verify(token, { resource, minAmount: priceMicros });
          res.set("Tollgate-Receipt-Id", req.tollgate.jti);
          return next();
        } catch (err) {
          if (!(err instanceof ReceiptError)) throw err;
          receiptError = { code: err.code, message: err.message };
        }
      }

      const quote: Quote = {
        version: PROTOCOL_VERSION,
        hub: verifier.hubUrl,
        seller: options.sellerId,
        price,
        currency: "USD",
        resource,
        url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        description: resolve(options.description, req),
        nonce: randomBytes(16).toString("base64url"),
      };
      const body: PaymentRequiredBody = {
        error: "payment_required",
        message: `This resource costs $${price}. Pay through Tollgate and retry with a ${RECEIPT_HEADER} header.`,
        tollgate: quote,
        ...(receiptError && { receiptError }),
      };
      res
        .status(402)
        .set(PRICE_HEADER, `${price} USD`)
        .set("WWW-Authenticate", `Tollgate hub="${verifier.hubUrl}", seller="${options.sellerId}", price="${price}"`)
        .json(body);
    } catch (err) {
      next(err);
    }
  };
}
