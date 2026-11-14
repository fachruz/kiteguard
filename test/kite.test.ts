import { test } from "node:test";
import assert from "node:assert/strict";
import { CliKite, createKiteAdapter, ttlToSeconds } from "../src/kite.js";

test("ttlToSeconds parses the documented duration forms", () => {
  assert.equal(ttlToSeconds("3600"), 3600);
  assert.equal(ttlToSeconds("30m"), 1800);
  assert.equal(ttlToSeconds("2h"), 7200);
  assert.equal(ttlToSeconds("24h"), 86400);
  assert.equal(ttlToSeconds("7d"), 604800);
  assert.throws(() => ttlToSeconds("soon"), /Unparseable TTL/);
});

test("delegation matches the installed CLI's schema (kpass 6.13.2)", () => {
  const kite = new CliKite();
  const d = kite.buildDelegation("Query the weather API for a 5-day forecast.", 1, 5, "2h") as Record<string, unknown>;
  const pp = d.payment_policy as Record<string, unknown>;
  assert.equal((d.task as Record<string, unknown>).summary, "Query the weather API for a 5-day forecast.");
  // Caps are decimal STRINGS in the real schema, TTL is integer seconds.
  assert.equal(pp.max_amount_per_tx, "1");
  assert.equal(pp.max_total_amount, "5");
  assert.equal(pp.ttl_seconds, 7200);
  assert.equal(pp.currency, "USD");
  // There is deliberately no `assets` field — the backend ignores one,
  // and no outer {"delegation": ...} wrapper — the CLI adds it.
  assert.equal("assets" in pp, false);
  assert.equal("delegation" in d, false);
});

test("mock session refuses payment after its TTL expires", async () => {
  const kite = createKiteAdapter(); // default mode is mock
  const session = await kite.createSession("ttl test", 1, 5, "1s");
  session.expiresAt = new Date(Date.now() - 1000).toISOString(); // already expired
  const res = await kite.execute(session, {
    id: "svc-weather-basic",
    name: "WeatherNow Basic API",
    description: "Current weather.",
    priceUsd: 0.5,
    url: "https://api.example.com/weather",
  });
  assert.equal(res.ok, false);
  assert.match(res.detail, /expired/i);
  assert.equal(session.spentUsd, 0);
});

test("mock catalog token search separates the premium listings", async () => {
  const kite = createKiteAdapter();
  const premium = await kite.searchCatalog("premium");
  assert.deepEqual(
    premium.map((s) => s.id).sort(),
    ["svc-weather-premium", "svc-weather-premium-annual"],
  );
  const annual = await kite.searchCatalog("annual premium");
  assert.deepEqual(annual.map((s) => s.id), ["svc-weather-premium-annual"]);
});
