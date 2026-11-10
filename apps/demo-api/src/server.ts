import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoApis } from "./app.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const demoFile = join(ROOT, "data", "demo.json");
if (!existsSync(demoFile)) {
  console.error("No demo sellers yet. Start the hub, then run: npm run try setup");
  process.exit(1);
}
const demo = JSON.parse(readFileSync(demoFile, "utf8")) as { sellerId: string; quickLeadsSellerId?: string };
if (!demo.quickLeadsSellerId) {
  console.error("Demo data is from an older setup. Run: npm run try setup --force");
  process.exit(1);
}

const hubUrl = process.env.HUB_URL || "http://localhost:4000";
const atlasPort = Number(process.env.PORT || process.env.DEMO_API_PORT || 4100);
const leadsPort = Number(process.env.DEMO_LEADS_PORT || 4200);

const { atlas, quickLeads } = createDemoApis({ hubUrl, atlasSellerId: demo.sellerId, quickLeadsSellerId: demo.quickLeadsSellerId });

atlas.listen(atlasPort, () => console.log(`Atlas Data (demo paid API) on http://localhost:${atlasPort}`));
quickLeads.listen(leadsPort, () => console.log(`QuickLeads (unvetted demo seller) on http://127.0.0.1:${leadsPort}`));
