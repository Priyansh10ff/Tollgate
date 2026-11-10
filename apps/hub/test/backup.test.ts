import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Ledger } from "../src/ledger.ts";
import { Participants } from "../src/services/participants.ts";
import { Users } from "../src/services/users.ts";
import { Backups, restoreIfMissing, supabaseStore, type BackupStore } from "../src/backup.ts";

const memoryStore = () => {
  let saved: Uint8Array | null = null;
  let puts = 0;
  const store: BackupStore & { puts: () => number } = {
    name: "memory",
    get: async () => saved,
    put: async (d) => {
      saved = d;
      puts++;
    },
    puts: () => puts,
  };
  return store;
};

test("a database survives losing the disk: snapshot, wipe, restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tollgate-backup-"));
  const path = join(dir, "data", "tollgate.db");
  const store = memoryStore();
  try {
    assert.equal(await restoreIfMissing(path, store), "fresh");
    const db = openDb(path);
    const users = new Users(db);
    const { user } = users.signup("ana@example.com", "password123");
    new Participants(db, new Ledger(db)).createAgent("Ana's agent", {}, user.id);

    const backups = new Backups(db, path, store, () => undefined);
    await backups.snapshot();
    assert.equal(store.puts(), 1);

    // A freshly restored server doesn't re-upload the copy it just loaded.
    const primed = new Backups(db, path, store, () => undefined);
    primed.prime();
    await primed.snapshot();
    assert.equal(store.puts(), 1);
    await backups.snapshot();
    assert.equal(store.puts(), 1, "unchanged data isn't uploaded again");
    db.close();

    // The host throws the disk away.
    rmSync(join(dir, "data"), { recursive: true, force: true });
    assert.equal(existsSync(path), false);

    assert.equal(await restoreIfMissing(path, store, () => undefined), "restored");
    const back = openDb(path);
    assert.equal(new Users(back).login("ana@example.com", "password123").user.email, "ana@example.com");
    assert.equal(new Participants(back, new Ledger(back)).listAgents(user.id)[0]?.name, "Ana's agent");
    back.close();

    // An existing local database is never overwritten.
    assert.equal(await restoreIfMissing(path, store), "kept-local");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Supabase store: upserts with the key, creates the bucket on first use, reads it back", async () => {
  const objects = new Map<string, Buffer>();
  const buckets = new Set<string>();
  const seen: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push(`${req.method} ${req.url} key=${req.headers.apikey === "sb_secret_x" && req.headers.authorization === "Bearer sb_secret_x"}`);
    if (req.method === "POST" && req.url === "/storage/v1/bucket") {
      buckets.add(JSON.parse(body.toString()).id);
      return void res.writeHead(200).end("{}");
    }
    const m = req.url!.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (!m) return void res.writeHead(404).end();
    if (!buckets.has(m[1]!)) return void res.writeHead(400).end('{"statusCode":"404","error":"Bucket not found"}');
    if (req.method === "POST") {
      assert.equal(req.headers["x-upsert"], "true");
      objects.set(m[2]!, body);
      return void res.writeHead(200).end("{}");
    }
    const obj = objects.get(m[2]!);
    if (!obj) return void res.writeHead(400).end('{"statusCode":"404","error":"not_found","message":"Object not found"}');
    res.writeHead(200).end(obj);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const store = supabaseStore({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, key: "sb_secret_x", bucket: "tollgate-backups" });
    assert.equal(await store.get(), null);
    await store.put(new Uint8Array([1, 2, 3]));
    await store.put(new Uint8Array([4, 5]));
    assert.deepEqual([...(await store.get())!], [4, 5]);
    assert.ok(seen.every((s) => s.endsWith("key=true")), "key sent in both headers");
    assert.ok(seen.includes("POST /storage/v1/bucket key=true"), "bucket created on first upload");
  } finally {
    server.close();
  }
});
