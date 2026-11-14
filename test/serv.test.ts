import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ServClient } from "../src/serv.js";

/**
 * Live-mode SERV client, tested against a local stub that mimics the
 * documented OpenServ inference API shape (docs.openserv.ai):
 *   POST /v1/chat/completions, OpenAI-compatible, system message
 *   MANDATORY on every request.
 * No real API key exists yet (that is Fachruz's end-stage step); the
 * stub proves the live code path is plug-and-play when it arrives.
 */

interface SeenRequest {
  authorization?: string;
  body: {
    model?: string;
    response_format?: { type?: string };
    messages?: Array<{ role: string; content: string }>;
  };
}

const seen: SeenRequest[] = [];
let server: Server;
let baseUrl: string;

function replyJson(res: import("node:http").ServerResponse, content: string) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as SeenRequest["body"];
      seen.push({ authorization: req.headers.authorization, body });
      const userText = body.messages?.find((m) => m.role === "user")?.content ?? "";
      if (userText.includes("Need:")) {
        // Ranking call: reverse the ids the client sent, to prove order is honoured.
        const ids = [...userText.matchAll(/id=(\S+)/g)].map((m) => m[1]).reverse();
        replyJson(res, JSON.stringify({ order: ids, why: "stub ranking: reversed on purpose" }));
      } else {
        // Plan call: deliberately ask for budgets ABOVE the owner defaults —
        // the client must clamp them back down at the boundary.
        replyJson(
          res,
          JSON.stringify({
            need: "weather for a week",
            catalogQuery: "weather",
            maxPerTxUsd: 99,
            maxTotalUsd: 999,
            expectedCalls: 3,
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("live plan: system message is sent, bearer auth used, budgets clamped", async () => {
  const client = new ServClient("test-key-not-a-real-secret", baseUrl);
  assert.equal(client.mode, "live");
  const result = await client.planPurchase("weather please", { maxPerTxUsd: 1, maxTotalUsd: 5 });
  assert.equal(result.mode, "live");
  assert.equal(result.data.catalogQuery, "weather");
  assert.equal(result.data.expectedCalls, 3);
  // The model proposed $99/$999; the owner defaults win.
  assert.equal(result.data.maxPerTxUsd, 1);
  assert.equal(result.data.maxTotalUsd, 5);

  const req = seen.at(-1);
  assert.ok(req);
  assert.equal(req.authorization, "Bearer test-key-not-a-real-secret");
  const system = req.body.messages?.find((m) => m.role === "system");
  assert.ok(system, "SERV rejects requests without a system message — one must be present");
  assert.match(system.content, /planning component of KiteGuard/i);
  assert.equal(req.body.response_format?.type, "json_schema");
});

test("live ranking: SERV's order is honoured and its explanation kept separate", async () => {
  const client = new ServClient("test-key-not-a-real-secret", baseUrl);
  const candidates = [
    { id: "svc-a", name: "A", description: "first", priceUsd: 0.5 },
    { id: "svc-b", name: "B", description: "second", priceUsd: 0.4 },
  ];
  const result = await client.rankCandidates("weather", candidates);
  assert.equal(result.mode, "live");
  assert.deepEqual(result.data.map((c) => c.id), ["svc-b", "svc-a"]); // stub reversed them
  assert.match(result.explanation, /stub ranking/i);
  const req = seen.at(-1);
  assert.ok(req?.body.messages?.some((m) => m.role === "system"));
});

test("no key means mock mode — the client never fakes a live call", () => {
  const client = new ServClient(undefined, baseUrl);
  assert.equal(client.mode, "mock");
});
