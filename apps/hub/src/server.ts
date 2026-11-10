import { loadConfig } from "./config.ts";
import { createHub } from "./hub.ts";
import { createApp } from "./app.ts";
import { Backups, restoreIfMissing, supabaseStore } from "./backup.ts";

const config = loadConfig();

if (process.env.NODE_ENV === "production" && (!config.adminToken || config.adminToken === "change-me")) {
  console.error('Refusing to start: set HUB_ADMIN_TOKEN to a long random value (it is still "change-me").');
  process.exit(1);
}

// On a throwaway disk, bring the database back from the last backup before opening it.
const store = config.backup
  ? supabaseStore({ url: config.backup.supabaseUrl, key: config.backup.supabaseKey, bucket: config.backup.bucket })
  : undefined;
if (store) {
  try {
    const result = await restoreIfMissing(config.dbPath, store);
    if (result === "fresh") console.log(`No backup in ${store.name} yet: starting with an empty database.`);
  } catch (err) {
    // Never start empty when a backup might exist: the next snapshot would overwrite it.
    console.error(`Refusing to start: couldn't read the backup from ${store.name}. ${(err as Error).message}`);
    process.exit(1);
  }
}

const hub = createHub(config);
const app = createApp(hub);
const backups = store && config.backup ? new Backups(hub.db, config.dbPath, store) : undefined;
// Only upload once something changes here: during a deploy the old server is still running,
// and its newer backups must not be replaced by the copy this one just restored.
backups?.prime();
backups?.start(config.backup!.intervalSeconds * 1000);

const server = app.listen(config.port, () => {
  // The hosted demo agent calls the hub over loopback instead of the public URL.
  hub.demo.internalHubUrl = `http://127.0.0.1:${config.port}`;
  const mode = hub.paypal.mode;
  console.log(`\nTollgate hub running at ${config.hubUrl}`);
  console.log(`PayPal: ${mode === "mock" ? "SIMULATED (no PayPal keys in .env)" : mode}`);
  const { anthropicApiKey, claudeModel } = config.demo;
  console.log(
    `Demo agent: ${anthropicApiKey && claudeModel ? `Claude (${claudeModel})` : `replay only (missing ${[!anthropicApiKey && "ANTHROPIC_API_KEY", !claudeModel && "CLAUDE_MODEL"].filter(Boolean).join(" and ")})`}`,
  );
  console.log(`Backups: ${store ? `${store.name}, every ${config.backup!.intervalSeconds}s` : "off"}`);
  if (config.adminToken === "change-me") console.log('Warning: HUB_ADMIN_TOKEN is still "change-me"');
  console.log("");
});

// Keep payout statuses in sync with PayPal.
const timer = setInterval(() => void hub.payouts.refreshAll(), 30_000);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  hub.demo.close();
  server.close();
  server.closeAllConnections(); // live event streams would otherwise keep the server open
  try {
    await backups?.stop();
    if (backups) console.log("Saved the final backup.");
  } catch (err) {
    console.error(`Final backup failed: ${(err as Error).message}`);
  }
  hub.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
