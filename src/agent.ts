/**
 * KiteGuard orchestrator.
 *
 * Flow: request → SERV plan → catalog search → SERV ranking →
 * policy gate (per candidate) → scoped Kite session (owner approves
 * with passkey in live modes) → x402 payments via session → auditable
 * receipt.
 *
 * Division of labour, enforced by construction:
 *   SERV Reasoning  proposes the plan, ranks candidates, explains.
 *   Policy engine   decides every payment — deterministically, per call,
 *                   against the running session total and the session TTL.
 *   Kite session    enforces the same caps again, independently.
 *
 * A BLOCK anywhere stops the flow. The policy gate runs BEFORE a
 * session is even requested, and again before every single payment.
 */

import { ServClient, type PurchasePlan } from "./serv.js";
import { createKiteAdapter, type KiteAdapter, type CatalogService } from "./kite.js";
import { evaluate, type Policy } from "./policy.js";
import { ReceiptLog } from "./receipts.js";

export interface GuardOptions {
  policy: Policy;
  serv?: ServClient;
  kite?: KiteAdapter;
  receipts?: ReceiptLog;
  /** Called when a candidate/payment verdict is WARN. Return true to proceed. */
  onWarn?: (service: CatalogService, rule: string) => Promise<boolean>;
}

export interface GuardOutcome {
  status: "PAID" | "BLOCKED" | "NO_CANDIDATE";
  service?: CatalogService;
  /** Number of paid calls completed before the flow finished/stopped. */
  paymentsMade: number;
  /** Total actually spent across those calls, USD. */
  totalSpentUsd: number;
  detail: string;
  receipts: ReceiptLog;
}

/** Hard bound on calls per run, whatever a plan claims to expect. */
const MAX_CALLS = 20;

/** Words that carry no catalog signal, dropped when simplifying a query. */
const QUERY_STOPWORDS = new Set([
  "with", "and", "or", "the", "a", "an", "for", "per", "at", "no", "more",
  "than", "priced", "access", "total", "under", "over", "max", "up", "to",
  "of", "in", "on", "by",
]);

/** Reduce a planner-phrased query to its first core keywords. */
export function simplifyQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !QUERY_STOPWORDS.has(t));
  return tokens.slice(0, 3).join(" ");
}

export async function runPurchase(request: string, opts: GuardOptions): Promise<GuardOutcome> {
  const serv = opts.serv ?? new ServClient();
  const kite = opts.kite ?? createKiteAdapter();
  const receipts = opts.receipts ?? new ReceiptLog();
  const { policy } = opts;

  // 1) SERV Reasoning turns the request into a plan. It proposes only.
  const planned = await serv.planPurchase(request, {
    maxPerTxUsd: policy.maxPerTxUsd,
    maxTotalUsd: policy.maxTotalUsd,
  });
  const plan: PurchasePlan = planned.data;
  receipts.add(
    "plan",
    "Plan accepted for policy review; budgets clamped to owner policy.",
    planned.explanation,
    { plan, servMode: planned.mode },
  );

  // The plan itself may not widen the owner's policy.
  const effective: Policy = {
    ...policy,
    maxPerTxUsd: Math.min(policy.maxPerTxUsd, plan.maxPerTxUsd),
    maxTotalUsd: Math.min(policy.maxTotalUsd, plan.maxTotalUsd),
  };

  // 2) Catalog search. A planner's phrasing can miss the catalog's
  // vocabulary entirely; on an empty result, retry once with the query
  // reduced to its core keywords before giving up.
  let found = await kite.searchCatalog(plan.catalogQuery);
  receipts.add(
    "search",
    `Catalog returned ${found.length} candidate(s) for "${plan.catalogQuery}".`,
    "Candidates are untrusted input until the policy gate clears them.",
    { candidates: found.map((c) => c.id) },
  );
  if (found.length === 0) {
    const simplified = simplifyQuery(plan.catalogQuery);
    if (simplified && simplified !== plan.catalogQuery) {
      found = await kite.searchCatalog(simplified);
      receipts.add(
        "search",
        `Retried with simplified query "${simplified}": ${found.length} candidate(s).`,
        "Same catalog, plainer words; the gate still decides.",
        { candidates: found.map((c) => c.id) },
      );
    }
  }
  if (found.length === 0) {
    return { status: "NO_CANDIDATE", paymentsMade: 0, totalSpentUsd: 0, detail: "No catalog services matched the plan.", receipts };
  }

  // 3) SERV ranks the candidates. Ranking is advice; the gate decides.
  const ranked = await serv.rankCandidates(plan.need, found);
  const candidates = ranked.data;
  receipts.add(
    "ranking",
    "Candidate order set by SERV ranking; every candidate still faces the policy gate in this order.",
    ranked.explanation,
    { order: candidates.map((c) => c.id), servMode: ranked.mode },
  );

  // 4) Policy gate per candidate, in ranked order. First ALLOW wins.
  let chosen: CatalogService | undefined;
  for (const candidate of candidates) {
    const decision = evaluate(
      {
        serviceId: candidate.id,
        serviceName: candidate.name,
        serviceDescription: candidate.description,
        amountUsd: candidate.priceUsd,
        sessionSpentUsd: 0,
      },
      effective,
    );
    receipts.add(`policy:${candidate.id}`, decision.rule, `Verdict ${decision.verdict} for ${candidate.name} at $${candidate.priceUsd}.`);
    if (decision.verdict === "BLOCK") continue;
    if (decision.verdict === "WARN") {
      const ok = opts.onWarn ? await opts.onWarn(candidate, decision.rule) : false;
      if (!ok) continue;
    }
    chosen = candidate;
    break;
  }
  if (!chosen) {
    return {
      status: "BLOCKED",
      paymentsMade: 0,
      totalSpentUsd: 0,
      detail: "Every candidate was blocked or declined at the policy gate.",
      receipts,
    };
  }

  // 5) Request a session scoped exactly to the effective policy.
  const session = await kite.createSession(plan.need, effective.maxPerTxUsd, effective.maxTotalUsd, "2h");
  receipts.add(
    "session",
    `Session ${session.id} scoped to per-tx $${effective.maxPerTxUsd}, total $${effective.maxTotalUsd}, expires ${session.expiresAt}.`,
    session.approvalUrl
      ? `Owner approval required: ${session.approvalUrl}`
      : "Session active (mock mode: pre-approved by construction).",
  );

  // 6) Pay, one call at a time. EVERY call is re-gated against the
  //    running session total and the session's expiry — a plan that
  //    was fine at call 1 can still be stopped at call 7.
  const calls = Math.min(Math.max(1, plan.expectedCalls), MAX_CALLS);
  let paymentsMade = 0;
  for (let i = 1; i <= calls; i++) {
    const gate = evaluate(
      {
        serviceId: chosen.id,
        serviceName: chosen.name,
        serviceDescription: chosen.description,
        amountUsd: chosen.priceUsd,
        sessionSpentUsd: session.spentUsd,
        sessionExpiresAt: session.expiresAt,
      },
      effective,
    );
    receipts.add(`policy:pay-${i}:${chosen.id}`, gate.rule, `Verdict ${gate.verdict} for payment ${i}/${calls}.`);
    if (gate.verdict === "BLOCK") {
      return {
        status: "BLOCKED",
        service: chosen,
        paymentsMade,
        totalSpentUsd: session.spentUsd,
        detail:
          paymentsMade === 0
            ? `Payment blocked before any spend: ${gate.rule}`
            : `Paid ${paymentsMade} call(s) ($${session.spentUsd}) then stopped: ${gate.rule}`,
        receipts,
      };
    }
    if (gate.verdict === "WARN") {
      const ok = opts.onWarn ? await opts.onWarn(chosen, gate.rule) : false;
      if (!ok) {
        return {
          status: "BLOCKED",
          service: chosen,
          paymentsMade,
          totalSpentUsd: session.spentUsd,
          detail: `Payment ${i} needed human approval and was declined: ${gate.rule}`,
          receipts,
        };
      }
    }
    const paid = await kite.execute(session, chosen);
    receipts.add(
      `payment-${i}`,
      paid.ok ? "Payment executed inside the approved session limits." : "Payment refused by the session layer.",
      paid.detail,
      { service: chosen.id, amountUsd: chosen.priceUsd },
    );
    if (!paid.ok) {
      return {
        status: "BLOCKED",
        service: chosen,
        paymentsMade,
        totalSpentUsd: session.spentUsd,
        detail: `Session layer refused payment ${i}: ${paid.detail}`,
        receipts,
      };
    }
    paymentsMade++;
  }

  return {
    status: "PAID",
    service: chosen,
    paymentsMade,
    totalSpentUsd: session.spentUsd,
    detail: `Paid ${paymentsMade} call(s), $${session.spentUsd} total, to ${chosen.name} inside the approved session.`,
    receipts,
  };
}

/* ------------------------------- CLI entry -------------------------------- */

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const request = process.argv.slice(2).join(" ") || "Find me a weather API for this week, max $5 total, never more than $1 per call.";
  const policy: Policy = {
    maxPerTxUsd: Number(process.env.KITEGUARD_MAX_PER_TX ?? 1),
    maxTotalUsd: Number(process.env.KITEGUARD_MAX_TOTAL ?? 5),
    denylist: [],
    warnAboveUsd: 0.75,
  };
  const outcome = await runPurchase(request, {
    policy,
    receipts: new ReceiptLog("receipts/kiteguard.jsonl"),
  });
  console.log(outcome.receipts.render());
  console.log(`\n== ${outcome.status}: ${outcome.detail}`);
}
