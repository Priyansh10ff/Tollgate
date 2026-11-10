import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { createHub } from "../src/hub.ts";
import { createApp } from "../src/app.ts";
import { PayPalMock } from "../src/paypal/index.ts";

export const ADMIN = "test-admin-token";

/** A hub with an in-memory database and simulated PayPal. */
export function testHub() {
  const config = loadConfig({ dbPath: ":memory:", adminToken: ADMIN, hubUrl: "http://hub.test", feeBps: 100 });
  const paypal = new PayPalMock(config.hubUrl);
  const hub = createHub(config, { db: openDb(":memory:"), paypal });
  return { hub, paypal };
}

/** Starts the HTTP app on a random port. */
export async function testServer() {
  const { hub, paypal } = testHub();
  const app = createApp(hub);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const api = async (method: string, path: string, body?: unknown, token = ADMIN) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : text };
  };
  return { hub, paypal, base, api, close: () => new Promise<void>((r) => server.close(() => r())) };
}
