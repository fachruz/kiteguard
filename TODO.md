# KiteGuard — build checklist (deadline: Sun 16 Nov 2026, 06:59 WIB)

Rules digest lives in the goal's `hidden_files/aturan-openserv.md`;
concept & rationale in `hidden_files/konsep-build-openserv.md`.
Submission needs: public repo + demo (link/video) + short write-up
(what it does, how it uses SERV Reasoning, track = Kite, what was built
during the hackathon) + an X post whose link goes into the submission form.

## Wed 11 Nov (kickoff) — DONE at scaffold time
- [x] Rules locked from official sources (hackathon-2 page, docs.openserv.ai, docs.gokite.ai)
- [x] Concept chosen: KiteGuard (SERV plan → policy gate → scoped Kite session → x402 pay → audit receipt)
- [x] Repo scaffolded: SERV client (mock fallback), policy engine, kpass adapter (mock), receipts, demo skeleton, policy tests
- [x] Smoke check: install / build / test / demo

## Thu 12 Nov — core build (DONE early, Wed 11 Nov)
- [x] SERV Reasoning: structured plan output (JSON schema) + catalog ranking; live path unit-tested against a local stub of the documented API (system message asserted) — real-API verification waits for Fachruz's key (Fri)
- [x] Policy engine v1 complete: injection screen hardened (base64 / zero-width / letter-spacing / leetspeak / HTML-entity / percent-encoding obfuscation), denylist, per-tx cap, session budget on running totals, session TTL; WARN path wired per-candidate and per-payment in the agent flow
- [x] Receipts: persistent JSONL audit log (`receipts/`) + human-readable rendering; deciding rule and SERV explanation separate on every entry
- [x] Kite adapter corrected to the REAL installed CLI (kpass 6.13.2): delegation-object session create (`--separate`), `session status --wait` polling, execute with `--idempotency-key`; catalog parser matched to the live `ksearch` response shape and verified against the real catalog
- [x] Probe (no accounts): kpass installed; sandbox = testnet + faucet money but login shared with live — sandbox removes the funding problem, NOT the account step. Full record: goal `hidden_files/probe-kpass-sandbox.md`
- [x] Tests: 32/32 (policy hardening, full three-scene flow, running totals, delegation shape, SERV stub)

## Fri 13 Nov — Kite integration (needs Fachruz's accounts — his steps, see runbook)
- [ ] Fachruz: OpenServ account + API key ($5 SERV credit if still offered); first live SERV call from the VM (runbook step 1)
- [ ] Fachruz: Passport sign-up (email link + passkey on phone + 8-char code); Muse registers the buyer agent (runbook step 2)
- [ ] Try SANDBOX mode end-to-end (sandbox on → faucet → session create → approve → execute a $0.01 catalog call). Settles the last UNVERIFIED: whether sandbox execution settles against the live catalog (runbook step 3)
- [ ] If sandbox can't pay: Fachruz decides — live mode with a tiny funded wallet (his call, his funds; ±$5 covers the demo session caps) or demo in sandbox+mock (runbook step 4)
- [ ] Attack scenario against the real adapter path (poisoned listing → BLOCK)

## Sat 14 Nov — demo & write-up (NEAR submission day — keep this light)
- [ ] Record/finalise demo (terminal capture or hosted run) ≤ ~2 min: legit ALLOW, poisoned BLOCK, over-cap BLOCK
- [ ] Write-up draft: what it does · SERV Reasoning's role · track Kite · new-vs-adapted disclosure (Gatekeeper pattern)
- [ ] README final pass (run instructions from a clean checkout)

## Sun 15 Nov — submission day (deadline 23:59 UTC = Mon 16 Nov 06:59 WIB; submit Sunday WIB, don't ride the deadline)
- [ ] Fachruz confirms: repo goes public + push
- [ ] Fachruz posts the X demo post (@openservai, #SERV / hackathon tags as the form expects)
- [ ] Fachruz confirms the exact submission payload → submit via the official form WITH the X post link
- [ ] Verify submission landed (screenshot/confirmation saved to goal files)

## Open verifications (from rules lock)
- [ ] Submission form URL (behind the page's submit button, after login)
- [x] Sandbox mechanics settled by probe: testnet + faucet, login shared with live; only "sandbox execute settles against the live catalog" remains open, settled at runbook step 3
- [ ] Per-prize split for the Kite track (still TBA on the official page)
