import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDemoApis } from "./app.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (existsSync(join(ROOT, ".env"))) process.loadEnvFile(join(ROOT, ".env"));

const demoFile = join(ROOT, "data", "demo.json");
type Demo = { sellerId: string; quickLeadsSellerId?: string };

function readDemo(): Demo | null {
  if (!existsSync(demoFile)) return null;
  try {
    const demo = JSON.parse(readFileSync(demoFile, "utf8")) as Demo;
    return demo.sellerId && demo.quickLeadsSellerId ? demo : null;
  } catch {
    return null;
  }
}

/** Waits until `npm run try setup` has created the demo sellers, then starts both APIs. */
async function waitForSetup(): Promise<Required<Demo>> {
  let demo = readDemo();
  if (!demo) {
    console.log("Waiting for the demo sellers. In another terminal run: npm run try setup");
    if (existsSync(demoFile)) console.log("(Your data/demo.json is from an older version: run npm run try setup --force)");
  }
  while (!demo) {
    await new Promise((r) => setTimeout(r, 2000));
    demo = readDemo();
  }
  return demo as Required<Demo>;
}

const demo = await waitForSetup();
const hubUrl = process.env.HUB_URL || "http://localhost:4000";
const atlasPort = Number(process.env.PORT || process.env.DEMO_API_PORT || 4100);
const leadsPort = Number(process.env.DEMO_LEADS_PORT || 4200);

const { atlas, quickLeads } = createDemoApis({ hubUrl, atlasSellerId: demo.sellerId, quickLeadsSellerId: demo.quickLeadsSellerId });

atlas.listen(atlasPort, () => console.log(`Atlas Data (demo paid API) on http://localhost:${atlasPort}`));
quickLeads.listen(leadsPort, () => console.log(`QuickLeads (unvetted demo seller) on http://127.0.0.1:${leadsPort}`));
