import { loadConfig } from "./config.ts";
import { createHub } from "./hub.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
const hub = createHub(config);
const app = createApp(hub);

const server = app.listen(config.port, () => {
  const mode = hub.paypal.mode;
  console.log(`\nTollgate hub running at ${config.hubUrl}`);
  console.log(`PayPal: ${mode === "mock" ? "SIMULATED (no PayPal keys in .env)" : mode}`);
  if (config.adminToken === "change-me") console.log('Warning: HUB_ADMIN_TOKEN is still "change-me"');
  console.log("");
});

// Keep payout statuses in sync with PayPal.
const timer = setInterval(() => void hub.payouts.refreshAll(), 30_000);

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    hub.db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
