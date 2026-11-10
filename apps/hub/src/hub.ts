import type { Config } from "./config.ts";
import { type DB, openDb } from "./db.ts";
import { Ledger } from "./ledger.ts";
import { EventBus } from "./events.ts";
import { createPayPal, type PayPalGateway } from "./paypal/index.ts";
import { Participants } from "./services/participants.ts";
import { Topups } from "./services/topups.ts";
import { Payouts } from "./services/payouts.ts";
import { Charges } from "./services/charges.ts";

export interface Hub {
  config: Config;
  db: DB;
  ledger: Ledger;
  events: EventBus;
  paypal: PayPalGateway;
  participants: Participants;
  topups: Topups;
  payouts: Payouts;
  charges: Charges;
}

/** Wires up all hub services. Tests pass an in-memory db and a mock PayPal. */
export function createHub(config: Config, deps: { db?: DB; paypal?: PayPalGateway } = {}): Hub {
  const db = deps.db ?? openDb(config.dbPath);
  const ledger = new Ledger(db);
  const events = new EventBus();
  const paypal = deps.paypal ?? createPayPal(config);
  const participants = new Participants(db, ledger);
  return {
    config,
    db,
    ledger,
    events,
    paypal,
    participants,
    topups: new Topups(db, ledger, participants, paypal, events, config.hubUrl),
    payouts: new Payouts(db, ledger, participants, paypal, events, config.minPayoutMicros),
    charges: new Charges(ledger, participants, events, config.feeBps),
  };
}
