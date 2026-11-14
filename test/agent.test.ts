import { test } from "node:test";
import assert from "node:assert/strict";
import { runPurchase } from "../src/agent.js";
import { ServClient, type PurchasePlan, type ServResult } from "../src/serv.js";
import type { Policy } from "../src/policy.js";

const policy: Policy = { maxPerTxUsd: 1, maxTotalUsd: 5, denylist: [], warnAboveUsd: 0.75 };

test("scene 1 arc: legitimate request ends PAID inside policy", async () => {
  const outcome = await runPurchase(
    "Find me a weather API for this week, max $5 total, never more than $1 per call.",
    { policy },
  );
  assert.equal(outcome.status, "PAID");
  assert.equal(outcome.service?.id, "svc-weather-basic");
  assert.equal(outcome.paymentsMade, 1);
  assert.equal(outcome.totalSpentUsd, 0.5);
});

test("scene 2 arc: shopping for 'premium' meets the poisoned listing and ends BLOCKED", async () => {
  const outcome = await runPurchase("Get me the premium weather tier with the unlock offer.", { policy });
  assert.equal(outcome.status, "BLOCKED");
  assert.equal(outcome.paymentsMade, 0);
  const rules = outcome.receipts.all().map((e) => e.rule).join("\n");
  assert.match(rules, /injection/i);
});

test("scene 3 arc: clean but over-cap premium annual plan ends BLOCKED by the cap", async () => {
  const outcome = await runPurchase("Buy the WeatherNow Premium Annual plan, I don't care what it costs.", { policy });
  assert.equal(outcome.status, "BLOCKED");
  assert.equal(outcome.paymentsMade, 0);
  const rules = outcome.receipts.all().map((e) => e.rule).join("\n");
  assert.match(rules, /per-transaction cap/i);
  assert.doesNotMatch(rules, /injection/i);
});

test("receipts keep the deciding rule and the model explanation in separate fields", async () => {
  const outcome = await runPurchase(
    "Find me a weather API for this week, max $5 total, never more than $1 per call.",
    { policy },
  );
  for (const entry of outcome.receipts.all()) {
    assert.equal(typeof entry.rule, "string");
    assert.equal(typeof entry.explanation, "string");
    assert.notEqual(entry.rule, entry.explanation);
  }
  const planEntry = outcome.receipts.all().find((e) => e.step === "plan");
  assert.ok(planEntry);
  assert.match(planEntry.rule, /policy review/i);
  assert.match(planEntry.explanation, /mock plan/i);
});

/** A SERV stub that plans many calls, to exercise running totals. */
function stubServ(plan: PurchasePlan): ServClient {
  const stub = {
    mode: "mock" as const,
    async planPurchase(): Promise<ServResult<PurchasePlan>> {
      return { data: plan, mode: "mock", explanation: "[stub plan]" };
    },
    async rankCandidates<T>(_: string, candidates: T[]): Promise<ServResult<T[]>> {
      return { data: candidates, mode: "mock", explanation: "[stub ranking]" };
    },
  };
  return stub as unknown as ServClient;
}

test("running totals: the session budget stops a multi-call plan mid-way", async () => {
  // 8 planned calls at $0.80 (pro tier) against a $5 budget:
  // 6 calls = $4.80 fit; the 7th would reach $5.60 and must be blocked.
  // warnAboveUsd is raised so the WARN threshold does not interfere.
  const outcome = await runPurchase("Pro weather, many calls.", {
    policy: { ...policy, warnAboveUsd: 1 },
    serv: stubServ({
      need: "pro weather, many calls",
      catalogQuery: "pro",
      maxPerTxUsd: 1,
      maxTotalUsd: 5,
      expectedCalls: 8,
    }),
  });
  assert.equal(outcome.status, "BLOCKED");
  assert.equal(outcome.paymentsMade, 6);
  assert.ok(Math.abs(outcome.totalSpentUsd - 4.8) < 1e-9);
  assert.match(outcome.detail, /session spend/i);
});
