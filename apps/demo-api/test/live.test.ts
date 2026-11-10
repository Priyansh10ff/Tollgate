import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDemoApis, fixtureSources, isPrivateAddress, liveSources, DataError } from "../src/app.ts";

test("private, loopback and metadata addresses are refused", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "151.101.1.69", "2606:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
});

test("reading a web page refuses internal addresses before any request", async () => {
  const sources = liveSources();
  for (const url of ["http://localhost:4000/api/overview", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "file:///etc/passwd", "http://example.com:8080/", "http://user:pw@example.com/"]) {
    await assert.rejects(sources.page(url), (err) => err instanceof DataError && err.status === 400, url);
  }
});

test("Atlas Data never asks to be paid for a lookup it can't answer", async () => {
  const { atlas } = createDemoApis({ hubUrl: "http://hub.test", atlasSellerId: "slr_atlas", quickLeadsSellerId: "slr_leads", sources: fixtureSources() });
  const server = http.createServer(atlas);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const unknown = await fetch(`${base}/v1/companies/NOPE`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).charged, false);

    const nowhere = await fetch(`${base}/v1/weather?city=Atlantis`);
    assert.equal(nowhere.status, 404);

    // A real lookup asks for payment with a quote.
    const known = await fetch(`${base}/v1/companies/NVDA/financials`);
    assert.equal(known.status, 402);
    const body = await known.json();
    assert.equal(body.tollgate.price, "0.05");
    assert.equal(body.tollgate.description, "Financials: NVDA");

    const catalog = await (await fetch(`${base}/v1/catalog`)).json();
    assert.ok(catalog.endpoints.some((e: { path: string }) => e.path.startsWith("/v1/f1")));
  } finally {
    server.close();
  }
});
