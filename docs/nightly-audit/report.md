# 0x-lens Nightly Audit Report

- **Date**: 2026-09-19
- **Auditor**: autonomous reliability-engineering agent (long-running session)
- **Baseline commit**: `6b63c3b195cd80356f301c5dd2c41182a27d5aba` (branch `main`, clean tree)
- **Audit branch**: `agent/nightly-0x-audit` (local only; never pushed)
- **Environment**: Windows 10 x64 (10.0.26200) · Node v20.19.4 · Microsoft Edge 153.0.0.0 (Chromium 153) via `e2e/browser.mjs` · fixture on `localhost:5173` · mock RPC on `127.0.0.1:5178` · browser concurrency 1–2 · CI-parity browser (Playwright Chromium) covered by the existing CI workflow.

---

## 1. Executive summary

**182 automated checks across 11 suites, all green at final validation** — plus 3 real product bugs reproduced first, fixed minimally, and locked behind regression tests:

| Bug | Symptom | Root cause | Fix | Regression |
|---|---|---|---|---|
| BUG-1 | Fixed-position addresses drift up to **3267 px** under window scroll | page-absolute boxes assume viewport→document conversion is scroll-only; fixed elements violate it and nothing observed scroll | scroll-anchor classification + throttled scroll-sensitive subset reposition | `e2e/audit/geometry.mjs` G11 |
| BUG-2 | Addresses inside `overflow:auto` containers drift **400–472 px** on inner scroll | inner scroll produces no MO record / layout-shift / transition event | same fix (scroller-anchored subset) | geometry.mjs G12/G13/G14 |
| BUG-3 | A hung RPC leaves the card as an eternal skeleton for **~49 s** | viem retries `TimeoutError` (default `retryCount: 3`): 4 × 12 s attempts + backoff | `transport http(..., { retryCount: 0 })` — one 12 s attempt, then `RPC_TIMEOUT` | `e2e/audit/rpc-privacy.mjs` R5 |

Sticky elements were **verified covered** by the existing layout-shift observer (G10) — an interesting non-obvious finding. All other investigated scenarios passed without product changes; test-only issues found during authoring (fixture authoring bugs, address collisions, a port-hogging zombie mock server, a stale profile-cached service worker) were fixed in the tests and are documented in §7.

**Product boundaries: unchanged.** Manifest still declares exactly `storage`, `sidePanel` + one host permission (the RPC origin); no `tabs`, no `scripting`, no remote code, no telemetry, CCIP-Read still disabled, EIP-7702 delegated EOAs still classified as EOA.

---

## 2. Baseline (at 6b63c3b)

| Check | Result |
|---|---|
| `npm run compile` | PASS |
| `npm run build` | PASS (911.6 kB) |
| `node e2e/verify.mjs` | 31/31 |
| `node e2e/rpc.mjs` (real mainnet) | 10/10 |
| `node e2e/card.mjs` (real mainnet) | 11/11 |
| `node e2e/panel.mjs` (real mainnet) | 10/10 |
| `node e2e/perf.mjs` | fixture 298 nodes/175 hl/141 ms · etherscan 2199/4/23 ms · wikipedia 2280/0/24 ms · x.com 66/7/25 ms |
| CI-defined local checks | compile + build + offline verify (identical to above) |

No pre-existing failures. Baseline manifest and environment recorded in `baseline.md`.

---

## 3. Scenario matrix (all statuses)

Suites: **D** = `e2e/audit/detect.mjs` (21/21) · **L** = `e2e/audit/lifecycle.mjs` (16/16) · **G** = `e2e/audit/geometry.mjs` (16/16) · **P** = `e2e/audit/perf.mjs` (8/8) · **C** = `e2e/audit/compat.mjs` (8/8) · **R/B/V** = `e2e/audit/rpc-privacy.mjs` (31/31, mock build) · **M/C** = `e2e/audit/mv3.mjs` (20/20, mock build) · **pre** = pre-existing suites (verify 31/31, rpc 10/10, card 11/11, panel 10/10).

### Address & ENS detection — `verified`
| Scenario | Status | Evidence |
|---|---|---|
| all-lower / all-upper / checksummed text → canonical checksummed identity | verified | D1–D3 |
| broken checksum (single flipped case) → no highlight | verified | D4 |
| two addresses in one text node; adjacent comma-separated; punctuation-wrapped | verified | D5–D7 |
| newline-separated addresses (pre-wrap) | verified | D8 |
| multi-rect address (92 px column, wraps 4–5 lines) → one box per line rect | verified | D9, G2 |
| truncated form recovered from matching href | verified | D10 |
| truncated prefix-mismatch / suffix-mismatch vs href → no highlight | verified | D11–D12 |
| href containing several addresses → consistent one wins | verified | D13 |
| href added late; href replaced → identity follows | verified | L14 (moved from detect: dynamic) |
| ENS name; 0x-prefixed label is a NAME (never an address) | verified | D16–D17 |
| email domains at any depth → no highlight | verified | D18 |
| unregistered name → detected (UI empty state proven in R7) | verified | D19 |
| unicode/emoji ENS → not detected, no crash, no mis-detection (documented limitation) | verified/limitation | D20 |
| script/style/noscript/template/textarea/input/contenteditable → never scanned | verified | D21–23 |
| hidden content → no visible box until shown | verified | D24, G15 |
| empty text node; 1 MB text node → no crash, bounded scan | verified | D25–D26 |
| page with >500 candidates → capped at 500 highlights, stable | verified | P-cap |

### SPA & DOM lifecycle — `verified`
| Scenario | Status | Evidence |
|---|---|---|
| characterData burst (50 rapid writes) settles on one highlight | verified | L1 |
| childList burst (50 add / 45 remove) → exactly survivors highlighted | verified | L2 |
| 100 synchronous add/remove cycles ×3 → no overlay leak | verified | L3 |
| node moved between two parents → exactly one highlight | verified | L4 |
| virtual-list recycling (same text nodes re-texted ×10) → per-row exactly one box, old identity released | verified | L5 |
| React-style hydration (identical text node swap) → no duplicate | verified | L6 |
| Vue-style subtree re-create → exactly one | verified | L7 |
| history.pushState + injection → scanned | verified | L8 |
| accordion open/close → box appears, fully releases | verified | L9 |
| document.body scope: node moved into same-document shadow root → pruned; returned → re-highlighted (`isConnected` is not scope) | verified | L13 |
| detached subtree mutated while detached, re-inserted → identity swap handled exactly once | verified | L12 |
| MutationObserver self-loop → zero extension-induced page mutations after settle | verified | L15 |
| navigation → exactly one fresh overlay per document, no residue | verified | L16 |
| back/forward restore → single overlay, scanner still live | verified | L17 |

### Geometry, scroll & layout — `reproduced→fixed` and `verified`
| Scenario | Status | Evidence |
|---|---|---|
| single-line box == live Range rect (±1.5 px) | verified | G1 (maxΔ 0.00 px) |
| multi-line wrap: N boxes == N rects | verified | G2 |
| transformed ancestor (static) | verified | G3 |
| CSS transition; keyframe animation → final geometry via transitionend/animationend | verified | G4–G5 |
| late font load; image-driven layout shift; resize; DPR 1.5 emulation | verified | G6–G9 |
| **sticky under window scroll** | verified (covered by layout-shift observer) | G10 |
| **fixed element under window scroll** | **reproduced → fixed** | G11 (3267 px → 0.00 px) |
| **nested scroll container; doubly-nested; horizontal** | **reproduced → fixed** | G12/G13/G14 (408/472/400 px → 0.00 px) |
| display:none ↔ visible: boxes drop and return | verified | G15 |
| window scroll invariance (the core design assumption, normal flow) | verified | G16 |

Design-assumption verdict (§七): “page-absolute overlay ⇒ window scroll needs no listener” holds for normal flow **and** sticky elements (sticky displacement fires layout-shift entries), but **did not hold** for fixed elements and inner scrollers — fixed by the scroll-anchor subset mechanism (§4), which adds no polling and no per-scroll full traversal.

### MV3 service worker & message races — `verified` (mock build)
| Scenario | Status | Evidence |
|---|---|---|
| SW cold start resolves | verified | M1 (+ every suite's first resolve) |
| SW restart on demand: resolve works after lifecycle restart | verified | M5b/M5d |
| idle-termination under harness | documented limitation (CDP attachment disables MV3 idle shutdown; stopAllWorkers/closeTarget ineffective) — see LIMIT-1 | mv3.mjs comment + report §7 |
| request issued before restart completes; response after panel opens | verified | M3/M3b, M5b |
| 3 concurrent same-identity resolves → all succeed, **single** JSON-RPC batch POST | verified | M4/M4b |
| different identities concurrently | verified | S6 (A+SLOW, B+FAST) |
| fast sequential hovers; slow A answered after fast B → **stale response loses** | verified | M6 |
| card closed before response → no ghost card | verified | M7 |
| tab closed mid-request → SW healthy | verified | M8 |
| side panel reload → focus identity restored from storage.session | verified | M9 |
| storage.session lifecycle: correctly cleared on extension reload (session scope) | verified | M5 |
| focus identity rapid change → latest wins | verified | M3b + M6 |
| malformed messages (string/number/null/unknown-type/missing identity/bad address/empty name) → no crash, stable codes | verified | M2 |
| sender without tab id (openPanel from extension page) → safe no-op + focus write | verified | M3 |
| gesture rule preserved: no `await` before `sidePanel.open()` (code review + M3) | verified | code inspection |

### Cache correctness — `verified` (mock build)
| Scenario | Status | Evidence |
|---|---|---|
| address case normalization at detection (lower/upper → one canonical key) | verified | D1–D3 + C1 |
| second hover of same identity → zero new RPC (session cache hit) | verified | C1 |
| balance TTL expiry → refresh-only path (identity fields preserved, balance updated) | verified | S5 chain (backdated fetchedAt → refreshed balance, fresh fetchedAt) |
| failed resolve NOT cached → resolves after RPC recovers | verified | C2/C2b |
| in-flight coalescing → one batch for N concurrent identical resolves | verified | M4b |
| session scope: storage.session cleared on extension restart (proxy for browser-close semantics) | verified | M5 |
| ENS vs address keys: name identities carry their own inflight key (`identityKey` discriminated union) | verified (code) + R7–R8 | protocol.ts |

### RPC, errors & privacy — `reproduced→fixed` and `verified` (mock build)
| Scenario | Status | Evidence |
|---|---|---|
| HTTP 500 / 429 / non-JSON body / JSON-RPC error → stable `LOOKUP_FAILED` | verified | R1–R4 |
| hung connection → `RPC_TIMEOUT` in ~12 s | **reproduced → fixed** (49.1 s → 12.0 s) | R5 |
| default empty EOA → NO ON-CHAIN FOOTPRINT | verified | R6 |
| bytecode `undefined`/`0x` → EOA; funded EOA → chip EOA | verified | B1, R6 |
| correct `0xef0100‖addr` designator → **EOA · 7702** with delegate shown | verified | B2/B2b |
| 7702 prefix with wrong length → CONTRACT | verified | B3 |
| plain contract bytecode → CONTRACT | verified | B4 |
| token metadata multicall success → TOKEN + name·symbol | verified | B5 |
| decimals 40 → garbage filter → CONTRACT | verified | B6 |
| 100-char name → garbage filter → CONTRACT | verified | B7 |
| bytes32-style name failure → CONTRACT (documented limitation) | verified (via item-failure path) | B7 default |
| 2^200 wei balance → integer-formatted, no NaN/scientific | verified | B8 |
| ENS miss → UNREGISTERED NAME; resolver error → LOOKUP_FAILED | verified | R7–R8 |
| **CCIP-Read off**: `OffchainLookup` error → LOOKUP_FAILED with **zero** gateway fetches | verified | R9/R9b |
| raw RPC error / URL / key material never in card UI (open shadow root) | verified | leak asserts on R1–R5, R8 |
| non-RPC origin fetch from SW rejected (incl. sibling port) | verified | V2/V2b |
| manifest host_permissions == exactly the configured RPC origin; no tabs/scripting | verified | V1/V1b |
| batch partial failure (multicall `allowFailure`) → per-item degradation | verified | B3/B4/B6/B7 default path |

### Performance & resources — `verified` (3 runs per config; wall time includes idle scheduling)
| Config | Wall median (range) | Highlights |
|---|---|---|
| 1k nodes / 10 matches | 30 ms (29–30) | 10 |
| 5k nodes / 100 matches | 66 ms (57–134) | 100 |
| 10k nodes / 500 matches | 499 ms (468–500) | 500 |
| 10k nodes / 600 matches → **cap** | 487 ms (478–524) | 500 (capped) |
| explorer-style table (2805 nodes) | 177 ms (163–194) | 300 |

Churn: mutation burst (300 nodes), virtual-list recycle ×10, layout-shift ×10 → overlay counts stable, **no DOM growth**. Hover: first 884 ms, cached re-hover median 535 ms (animation-dominated). Full data: `perf-runs.json`. Main-thread time from `performance.measure('oxl:initial-scan')`; the scanner's 8 ms/chunk idle budget bounds per-chunk work by construction.

### Browser compatibility & boundaries — `verified`
| Scenario | Status | Evidence |
|---|---|---|
| Chromium family (Edge 153 locally; Playwright Chromium in CI) | verified | all suites (Edge) + CI workflow |
| strict-CSP page (`default-src 'self'`) → annotated without violations | verified | C1 |
| multi-iframe page → **no injection into frames** (top-frame-only), parent healthy | verified | C2 series |
| closed shadow root → not scanned (documented), page scans fine, no crash | verified | C3 series |
| SSR/static page, SPA, explorer-style page | verified | article.html nav (L16), pushState (L8), table config (P) |
| open shadow DOM content | verified | L13 |

---

## 4. Real problems: reproduction, root cause, minimal fix, regression

### BUG-1 / BUG-2 — scroll-anchored highlight drift (geometry)
- **Reproduction**: `fixture/audit.html` sections G10–G14; `node e2e/audit/geometry.mjs`. Settle all debounced repositions at scrollY=0, then scroll (window for fixed/sticky; the container for nested/horizontal), wait past all debounces, compare each `.hl` box to the live `Range.getClientRects()` of the address substring. Stable pre-fix deltas: fixed 3267 px, nested 408 px, doubly-nested 472 px, horizontal 400 px.
- **Root cause**: `place()` stores boxes in document-absolute coordinates (`rect.top + scrollY`). That mapping is only invariant for document-flow content. `position: fixed` elements keep a constant *viewport* rect, so their document position changes under window scroll; content inside an `overflow:auto` ancestor changes document position when that container scrolls — and no existing signal (MutationObserver, layout-shift, transition events) fires for either case. Sticky is the exception: Chromium reports sticky displacement as layout-shift entries, which the existing observer already converts into repositions (G10 verified pre-fix).
- **Minimal fix** (`src/core/scanner/scanner.ts`): each `MatchEntry` is classified at creation (and on full reposition passes) as `viewportAnchored` (fixed/sticky ancestor) and/or `scroller`-anchored (nearest `overflow: auto|scroll` ancestor). A capture-phase passive `scroll` listener records *what* scrolled; interval-throttled (≥50 ms between passes, plus one settle pass 150 ms after the last scroll) **subset** passes reposition only scroll-sensitive entries. Drop/prune paths clean the subset.
- **Performance impact**: pages with no scroll-sensitive matches pay one `Set.size` check per scroll event; scroll-sensitive subset repositions are capped at ~20 passes/s and touch only flagged entries (typically a handful; a 500-box scroller worst case repositions ~500 boxes 20×/s during active scroll — no per-frame cost, no full-page traversal, no idle-time polling). Measured end-to-end: geometry suite runtime unchanged.
- **Regression**: `e2e/audit/geometry.mjs` G11–G14 assert `maxDelta ≤ 1.5 px` post-fix (all 0.00 px); G10 guards the sticky path; detect/lifecycle/verify suites confirm no regressions.

### BUG-3 — hung RPC: ~49 s eternal skeleton
- **Reproduction**: mock-RPC build + rule `action: 'hang'` on `eth_getBalance` for the probe address; hover; time the response (`e2e/audit/rpc-privacy.mjs` R5).
- **Root cause**: viem's `buildRequest.shouldRetry` returns `true` for `TimeoutError` (not an abort error, not an HttpRequestError with status). With the default `retryCount: 3`, the 12 s transport timeout runs **4 times** plus exponential retry delays: measured 49.1 s before `RPC_TIMEOUT` surfaced. The card skeleton lasts the whole time — exactly the “infinite skeleton” failure mode the transport timeout was added to prevent.
- **Minimal fix** (`src/core/services/chain.ts`): `http(rpcUrl, { batch: true, timeout: 12_000, retryCount: 0 })` — one attempt, then the stable code. Transient provider hiccups remain covered by the stale-balance refresh path and by the user simply re-hovering.
- **Regression**: R5 asserts `RPC_TIMEOUT` within 25 s (measured 12.0 s); R1–R4 confirm the other mappings still surface quickly.

---

## 5. Privacy & permissions audit

- **Manifest permissions (final build)**: `["storage", "sidePanel"]`, `host_permissions: ["https://ethereum.reth.rs/*"]` (mock build: `http://127.0.0.1:5178/*` — asserted equal by V1). **No new or modified permissions.**
- **Network egress**: SW fetch whitelist guard rejects every non-RPC origin, including sibling localhost ports (V2/V2b). CCIP-Read stays off — an `OffchainLookup` error surfaces as `LOOKUP_FAILED` with zero gateway requests (R9/R9b).
- **Error hygiene**: all error scenarios assert the card (open shadow root) contains only the stable code and no `http(s)`, endpoint host, port, or key-like material (R1–R5, R8 leak asserts).
- **No page content leaves the browser**: the only outbound calls are JSON-RPC identity lookups (method/params only), verified by the mock server's request log across all suites.
- **No remote code, no dynamic execution, no telemetry, no backend, no accounts**: unchanged from baseline (verified by `git diff` scope: scanner + chain config + tests/fixtures only).

## 6. Changed files & local commits

| Commit | Contents |
|---|---|
| `da60b51` fix: keep scroll-anchored highlights glued under fixed, sticky and nested scrolling | `src/core/scanner/scanner.ts`, `fixture/audit.html`, `e2e/audit/helpers.mjs`, `e2e/audit/geometry.mjs` |
| `1b83f05` test: add detection and DOM lifecycle audit suites | `e2e/audit/detect.mjs`, `lifecycle.mjs`, `ua.mjs` |
| `b5f2e3d` docs: record nightly audit baseline and state | `docs/nightly-audit/baseline.md`, `state.json` |
| `91aa26d` fix: cap RPC attempts at one so hung connections surface as RPC_TIMEOUT quickly | `src/core/services/chain.ts` |
| `d82d601` test: add mock-RPC suites for privacy boundary, MV3 lifecycle and cache semantics | `e2e/audit/mock-*.{mjs}`, `rpc-privacy.mjs`, `mv3.mjs`, `e2e/browser.mjs` (profile override) |
| `889add4` perf: add parameterised scan, churn and hover benchmark suite | `fixture/audit-perf.html`, `e2e/audit/perf.mjs`, `docs/nightly-audit/perf-runs.json` |
| `50ba7ba` test: add compatibility suite for strict CSP, iframes and closed shadow roots | `fixture/audit-compat.html`, `e2e/audit/compat.mjs` |
| *(final)* docs: audit report | `docs/nightly-audit/{report.md,interview-notes.md,state.json}` |

Production-code changes are limited to `src/core/scanner/scanner.ts` (BUG-1/2 fix) and `src/core/services/chain.ts` (BUG-3 fix). No existing tests were deleted, skipped, or weakened; no timeouts were relaxed to mask failures; pixel tolerance stayed at 1.5 px.

## 7. Test-infrastructure findings (documented, fixed in tests)

1. **Profile-cached service worker**: a persistent profile keeps serving a stale extension SW after rebuilds — it silently answered with a *previous build's* RPC target (balance 0 from the public endpoint while the mock expected the call). All mock suites now wipe their profile at start (`wipeProfile()`); matches the hazard documented in CLAUDE.md.
2. **Zombie mock server**: a crashed suite run left a server bound to 5178; later suites' config/log calls silently hit it (stale rules, stale code). A first guard (child exit-code check) lost the startup race — the zombie answers the readiness probe at ~50 ms while the doomed child needs ~600 ms to hit EADDRINUSE. The final guard is race-free identity: `__log` answers with the server's pid and `startMockRpc` asserts it equals the pid of the child it spawned (regression: `e2e/audit/verify-zombie-guard.mjs` reproduces the exact race window). Suites spawn their own server and `stop()` it in `finally`.
3. **viem 2.56 reverse resolution** calls the v2 universal resolver (`0xeeee…eeee`) with `reverseWithGateways`; a bare `0x` response raises `ContractFunctionExecutionError` (not null). The mock replays real-chain captures for faithful defaults.
4. **`eth_getCode`, not `eth_getBytecode`**, is the JSON-RPC method viem's `getBytecode` sends (mock rule naming).
5. Multicall calldata embeds addresses **without** the `0x` prefix; rule matching normalizes this.
6. Fixture-authoring traps hit and fixed: duplicate element ids (a stray button with `id="l9-accordion"` defeated the accordion CSS), `getElementById` cannot see nodes inside shadow trees, `classList.toggle(cls, false)` no-ops on first click, and cross-scenario address reuse masking counts (audits now use 46 exclusive EIP-55 addresses + rect-scoped assertions).
7. **Hover-intent theft**: an interpolated multi-step mouse path that dwells 200 ms on an unrelated box triggers that box's acquire sequence; race tests use single-hop `hoverDirect`.

## 8. Unresolved / documented limitations

- **LIMIT-1 (harness)**: MV3 idle termination cannot be exercised under a CDP-attached harness (attached sessions disable idle shutdown; `stopAllWorkers`/`closeTarget`/serviceworker-internals Stop are ineffective or read-only there). Termination→restart is covered indirectly (cold start in every suite; `chrome.runtime.reload()` lifecycle in M5); cross-termination storage persistence relies on Chrome's documented session-scoped guarantee for `storage.session`.
- **LIMIT-3 (new mechanism boundaries, found in review)**: the scroll-anchor classifier only recognizes `overflow: auto|scroll` ancestors. A `position: relative; overflow: hidden` container scrolled programmatically (`scrollTop = …`) is not tracked and its addresses still drift — identical to pre-fix behavior, and no real-world page pattern observed. Body-level `overflow` propagating the viewport scroller can classify an entry as scroller-anchored against the body — harmless (one extra subset reposition on inner scrolls, geometry still correct).
- **LIMIT-4 (harness, found wiring CI)**: the extension-reload scenario (mv3 M5) is not exercisable on every browser build. After `chrome.runtime.reload()`, playwright-core 1.63's bundled Chromium (the CI browser) never serves the extension again — `chrome-extension://` pages stay `ERR_BLOCKED_BY_CLIENT` and no background worker target returns (>30 s of retries), while local Edge 153 recovers in ~2 s. The M5 group therefore runs last in the suite and is skipped with an explicit log line on such builds; the reload lifecycle remains fully covered on local Edge runs. (The product itself never calls `runtime.reload()` — this scenario was always a harness-side lifecycle probe.)
- **Product limitations, verified intentional and safe**: unicode/emoji ENS (ASCII regex — no mis-detection, no crash); truncated addresses outside links; bytes32 `name()/symbol()` tokens → plain CONTRACT; closed shadow roots invisible to the scanner; iframes get no injection (top-frame only by design). All asserted non-crashing and non-mis-detecting in `detect.mjs`/`compat.mjs`.

## 9. Final quality gate

| Command | Result |
|---|---|
| `npm run compile` | PASS |
| `npm run build` (public) | PASS |
| `node e2e/verify.mjs` | 31/31 |
| `node e2e/rpc.mjs` | 10/10 |
| `node e2e/card.mjs` | 11/11 |
| `node e2e/panel.mjs` | 10/10 |
| `node e2e/audit/detect.mjs` | 21/21 |
| `node e2e/audit/lifecycle.mjs` | 16/16 |
| `node e2e/audit/geometry.mjs` | 16/16 |
| `node e2e/audit/perf.mjs` | 8/8 |
| `node e2e/audit/compat.mjs` | 8/8 |
| `node e2e/audit/rpc-privacy.mjs` (mock build) | 31/31 |
| `node e2e/audit/mv3.mjs` (mock build) | 20/20 (Edge; on CI Chromium 16/16 + documented M5 skip, LIMIT-4) |

**Total: 182 checks green across both build variants.** Fixture and mock servers stopped after runs; test browsers closed; ports 5173/5178 released; port 3100 untouched.
