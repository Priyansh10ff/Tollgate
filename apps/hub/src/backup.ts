import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "./db.ts";

/**
 * Keeps the SQLite ledger safe on hosts with a throwaway disk (like Render's free plan).
 * A consistent snapshot of the database is uploaded to object storage every few seconds
 * when something changed, and once more on shutdown. On startup, if there's no local
 * database yet, the latest snapshot is restored first.
 */

export interface BackupStore {
  /** The latest snapshot, or null if there is none yet. */
  get(): Promise<Uint8Array | null>;
  put(data: Uint8Array): Promise<void>;
  readonly name: string;
}

/** Supabase Storage (works with both the new sb_secret_ keys and legacy service_role keys). */
export function supabaseStore(options: { url: string; key: string; bucket: string; object?: string; fetch?: typeof fetch }): BackupStore {
  const base = options.url.replace(/\/+$/, "");
  const object = options.object ?? "tollgate.db";
  const http = options.fetch ?? fetch;
  const headers = { apikey: options.key, Authorization: `Bearer ${options.key}` };
  const objectUrl = `${base}/storage/v1/object/${encodeURIComponent(options.bucket)}/${encodeURIComponent(object)}`;

  const upload = (data: Uint8Array) =>
    http(objectUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream", "x-upsert": "true", "Cache-Control": "no-cache" },
      body: new Blob([data as Uint8Array<ArrayBuffer>]),
      signal: AbortSignal.timeout(20_000),
    });

  return {
    name: `Supabase Storage (${options.bucket}/${object})`,
    async get() {
      const res = await http(objectUrl, { headers, signal: AbortSignal.timeout(20_000) });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      const text = await res.text();
      if (res.status === 404 || /not.?found/i.test(text)) return null;
      throw new Error(`Supabase download failed (${res.status}): ${text.slice(0, 200)}`);
    },
    async put(data) {
      let res = await upload(data);
      if (!res.ok) {
        const text = await res.text();
        // First run: create the private bucket, then try again.
        if (/bucket.*not.?found/i.test(text) || res.status === 404) {
          const created = await http(`${base}/storage/v1/bucket`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ id: options.bucket, name: options.bucket, public: false }),
          });
          if (!created.ok && created.status !== 409) throw new Error(`Couldn't create Supabase bucket "${options.bucket}" (${created.status}): ${(await created.text()).slice(0, 200)}`);
          res = await upload(data);
          if (res.ok) return;
          throw new Error(`Supabase upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
        }
        throw new Error(`Supabase upload failed (${res.status}): ${text.slice(0, 200)}`);
      }
    },
  };
}

/** Restores the latest snapshot if the database file doesn't exist yet. Call before opening the database. */
export async function restoreIfMissing(dbPath: string, store: BackupStore, log = console.log): Promise<"restored" | "kept-local" | "fresh"> {
  if (existsSync(dbPath)) return "kept-local";
  const data = await store.get();
  if (!data) return "fresh";
  mkdirSync(dirname(dbPath), { recursive: true });
  for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  writeFileSync(dbPath, data);
  log(`Restored the database from ${store.name} (${Math.round(data.length / 1024)} KB)`);
  return "restored";
}

export class Backups {
  private lastHash = "";
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;

  constructor(
    private db: DB,
    private dbPath: string,
    private store: BackupStore,
    private log: (message: string) => void = console.log,
  ) {}

  /** Uploads a snapshot if the data changed since the last upload. */
  snapshot(): Promise<void> {
    // One at a time: if a snapshot is in flight, wait for it instead of starting another.
    this.running ??= this.doSnapshot().finally(() => (this.running = null));
    return this.running;
  }

  start(intervalMs: number) {
    this.timer = setInterval(() => {
      this.snapshot().catch((err: Error) => this.log(`Backup failed: ${err.message}`));
    }, intervalMs);
    this.timer.unref();
  }

  /** Final snapshot on shutdown. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
    await this.snapshot();
  }

  private async doSnapshot() {
    // VACUUM INTO writes a consistent, compact copy, including anything still in the WAL.
    const tmp = join(dirname(this.dbPath === ":memory:" ? join(process.cwd(), "x") : this.dbPath), `.snapshot-${process.pid}.db`);
    rmSync(tmp, { force: true });
    try {
      this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const data = readFileSync(tmp);
      const hash = createHash("sha256").update(data).digest("hex");
      if (hash === this.lastHash) return;
      await this.store.put(data);
      this.lastHash = hash;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}
