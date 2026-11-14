/**
 * Deterministic policy engine — the chaperone.
 *
 * The pattern is adapted from the author's Gatekeeper project (NEAR
 * agent-payment firewall): checks run in a FIXED order and the first
 * failing check decides. The model (SERV Reasoning) never appears in
 * this file: it proposes, this code decides.
 *
 * Order: (1) prompt-injection screen over untrusted catalog metadata,
 * (2) merchant denylist, (3) per-transaction cap, (4) session budget
 * (running total), (5) session TTL. A BLOCK is final. A WARN escalates
 * to a human. ALLOW proceeds.
 *
 * The injection screen does not read the raw listing text: it reads a
 * NORMALISED form (zero-width characters stripped, HTML entities and
 * percent-escapes decoded, base64 payloads decoded and screened too,
 * leetspeak folded, letter-spacing collapsed). Attackers obfuscate;
 * the screen undoes the obfuscation before matching, so the check is
 * at least as hard to evade as it is to read.
 */

export type Verdict = "ALLOW" | "WARN" | "BLOCK";

export interface Policy {
  maxPerTxUsd: number;
  maxTotalUsd: number;
  /** Merchant/service identifiers that must never be paid. */
  denylist: string[];
  /** Amounts above this (but within caps) need a human's OK. */
  warnAboveUsd: number;
}

export interface PaymentIntent {
  /** Service/merchant identifier from the Kite catalog. */
  serviceId: string;
  /** Human-readable service name. */
  serviceName: string;
  /** Untrusted free text from the catalog listing. Screened, never trusted. */
  serviceDescription: string;
  amountUsd: number;
  /** Total already spent inside the current session, USD (running total). */
  sessionSpentUsd: number;
  /** ISO timestamp when the spending session expires, if one is in play. */
  sessionExpiresAt?: string;
  /** ISO timestamp of the evaluation (defaults to now). Injectable for tests. */
  evaluatedAt?: string;
}

export interface PolicyDecision {
  verdict: Verdict;
  /** The rule that decided — stored on the receipt, apart from any model text. */
  rule: string;
}

/* ------------------------- injection screen ------------------------------ */

/**
 * Phrases that, when they appear in untrusted catalog metadata, mean the
 * listing is trying to instruct the agent. A legitimate service describes
 * what it does; it does not give the buyer's agent orders.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (the )?(previous|above|budget|limit|instruction|rule)/,
  /disregard (the )?(budget|limit|rule|instruction)/,
  /forget (the )?(budget|limit|rule|instruction)/,
  /override (the )?(budget|limit|rule|check|approval)/,
  /bypass (the )?(budget|limit|rule|check|approval|policy)/,
  /skip (the )?(budget|limit|rule|check|approval|policy|confirmation)/,
  /pay (the )?(premium|upgrade|full)/,
  /send (funds|payment|usdc|money|tokens?) to/,
  /transfer (funds|payment|usdc|money|tokens?|all)/,
  /instead,? (pay|buy|send|transfer)/,
  /you must (pay|buy|send|transfer)/,
  /(do not|don't|never) (tell|inform|notify|ask) (the )?(user|owner|human)/,
  /without (asking|confirmation|approval|telling)/,
  /(raise|increase|remove|lift) (the )?(budget|limit|cap)/,
  /new (instruction|directive|system prompt)/,
  /system prompt/,
  /act as (if|though)/,
  /approve (this|the) (payment|purchase|transaction) (now|immediately)/,
];

/** Zero-width and other invisible formatting characters used to split words. */
const INVISIBLE_CHARS = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;

/** Common leetspeak substitutions, folded back to letters before matching. */
const LEET: Record<string, string> = {
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t",
  "@": "a", "$": "s", "!": "i", "+": "t",
};

function foldLeet(s: string): string {
  return s.replace(/[013457@$!+]/g, (c) => LEET[c] ?? c);
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

function decodePercentEscapes(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) =>
    String.fromCodePoint(parseInt(h, 16)),
  );
}

/**
 * Decode every base64-looking token in the text and return the decoded
 * strings, so an instruction hidden inside an encoded blob is screened
 * as well. Junk decodes are harmless — they simply won't match.
 */
function decodeBase64Tokens(s: string): string[] {
  const out: string[] = [];
  const tokens = s.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [];
  for (const token of tokens) {
    if (token.length % 4 === 1) continue;
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      // Only keep decodes that look like text (mostly printable).
      const printable = [...decoded].filter((c) => c >= " " && c !== "�").length;
      if (decoded.length > 0 && printable / decoded.length > 0.85) out.push(decoded);
    } catch {
      /* not base64 after all — ignore */
    }
  }
  return out;
}

/**
 * Reduce untrusted text to the form the patterns are matched against:
 * lowercase, invisibles stripped, entities/percent-escapes decoded,
 * leetspeak folded, punctuation softened to spaces, whitespace squeezed.
 */
export function normalizeForScreening(raw: string): string {
  let s = raw.normalize("NFKC").toLowerCase();
  s = s.replace(INVISIBLE_CHARS, "");
  s = decodeHtmlEntities(s);
  s = decodePercentEscapes(s);
  s = foldLeet(s);
  s = s.replace(/[^a-z0-9\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * The same patterns with literal spaces removed, for matching against
 * de-spaced text — this is what catches "i g n o r e  t h e  b u d g e t"
 * and other letter-spacing tricks, where word boundaries themselves
 * are the obfuscation.
 */
const INJECTION_PATTERNS_DESPACED: RegExp[] = INJECTION_PATTERNS.map(
  (p) => new RegExp(p.source.replace(/ /g, ""), "i"),
);

function screenOne(normalized: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) return pattern.source;
  }
  const despaced = normalized.replace(/ /g, "");
  for (let i = 0; i < INJECTION_PATTERNS.length; i++) {
    if (INJECTION_PATTERNS_DESPACED[i].test(despaced)) return INJECTION_PATTERNS[i].source;
  }
  return null;
}

/**
 * Screen untrusted text for embedded instructions. Returns the matched
 * pattern source, or null when the text is clean. Screens the text
 * itself AND anything hidden in base64 blobs inside it.
 */
export function screenForInjection(untrustedText: string): string | null {
  const direct = screenOne(normalizeForScreening(untrustedText));
  if (direct) return direct;
  for (const decoded of decodeBase64Tokens(untrustedText)) {
    const hit = screenOne(normalizeForScreening(decoded));
    if (hit) return `${hit} (inside base64 payload)`;
  }
  return null;
}

/* ------------------------------ evaluation ------------------------------- */

export function evaluate(intent: PaymentIntent, policy: Policy): PolicyDecision {
  // 1) Injection screen — poisoned metadata blocks before anything else.
  const hit = screenForInjection(`${intent.serviceName}\n${intent.serviceDescription}`);
  if (hit) {
    return {
      verdict: "BLOCK",
      rule: `Catalog metadata matched injection pattern /${hit}/ — listing treated as hostile.`,
    };
  }
  // 2) Denylist.
  if (policy.denylist.includes(intent.serviceId)) {
    return { verdict: "BLOCK", rule: `Service ${intent.serviceId} is on the owner denylist.` };
  }
  // 3) Per-transaction cap.
  if (intent.amountUsd > policy.maxPerTxUsd) {
    return {
      verdict: "BLOCK",
      rule: `Amount $${intent.amountUsd} exceeds per-transaction cap $${policy.maxPerTxUsd}.`,
    };
  }
  // 4) Session budget, against the running total already spent.
  if (intent.sessionSpentUsd + intent.amountUsd > policy.maxTotalUsd) {
    return {
      verdict: "BLOCK",
      rule:
        `Amount $${intent.amountUsd} would bring session spend to ` +
        `$${intent.sessionSpentUsd + intent.amountUsd}, over the $${policy.maxTotalUsd} session budget.`,
    };
  }
  // 5) Session TTL — an expired session pays nothing, however small.
  if (intent.sessionExpiresAt) {
    const now = intent.evaluatedAt ? Date.parse(intent.evaluatedAt) : Date.now();
    const expiry = Date.parse(intent.sessionExpiresAt);
    if (Number.isFinite(expiry) && Number.isFinite(now) && now >= expiry) {
      return {
        verdict: "BLOCK",
        rule: `Spending session expired at ${intent.sessionExpiresAt}; a fresh owner-approved session is required.`,
      };
    }
  }
  // Within caps: large-ish payments still ask a human.
  if (intent.amountUsd > policy.warnAboveUsd) {
    return {
      verdict: "WARN",
      rule: `Amount $${intent.amountUsd} is above the $${policy.warnAboveUsd} human-approval threshold.`,
    };
  }
  return {
    verdict: "ALLOW",
    rule: "Within injection screen, denylist, per-transaction cap, session budget, session TTL and approval threshold.",
  };
}
