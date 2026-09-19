# Interview Notes — 0x-lens reliability audit

Answers to the required questions, grounded in what this audit actually
found and measured (not aspiration — each claim points at a test).

## TreeWalker and MutationObserver: who does what

The **TreeWalker** (`walker.ts`) is the *discovery* mechanism: it walks text
nodes under a root once, rejecting the subtrees that must never be scanned
(script, style, textarea, contenteditable, …) and pre-filtering nodes shorter
than the shortest candidate (5 chars, "a.eth"). It answers "what exists right
now". The **MutationObserver** (`scanner.ts`) is the *invalidation* mechanism:
it never scans by itself; it only records *what changed* (added subtrees,
changed text, late/replaced hrefs, removed nodes), debounces for 200 ms, and
hands a minimal work list back to the same scan path. Keeping discovery
pull-based and invalidation event-driven is what makes SPA churn cheap: a
framework that re-renders one row costs one text-node rescan, not a page walk.
The audit's lifecycle suite proves the split: 300-node mutation bursts and
virtual-list recycles leave the overlay exactly at baseline (L2/L3/L5).

## Why an independent overlay instead of touching the host DOM

`Range.getClientRects()` gives the exact line boxes of an address; painting
boxes for those rects in a separate Shadow DOM layer on
`document.documentElement` means the page's DOM is **never mutated** — React,
Vue or Svelte reconciliation can never see us, fight us, or be corrupted by
us. The compat suite shows the payoff under a strict `default-src 'self'`
CSP: the annotation layer injects and renders without tripping the policy
(C1), because it adds no inline scripts and no page-visible styles. The
cost of the design is that the overlay must track *layout truth* itself —
which is exactly where this audit found the real bugs (scroll anchors, §below).

## Why window scroll and nested scroll containers behave differently

Page-absolute coordinates (`rect.top + window.scrollY`) are invariant under
**window** scroll for normal-flow content: the viewport rect and the scroll
offset move in lockstep, so the stored page position stays correct — no
listener needed (G16, Δ=0.00 px). Two things break the invariant:

1. **`position: fixed`** — the viewport rect never changes while the document
   moves, so `rect.top + scrollY` changes *with* the scroll; the stored box
   goes stale (measured 3267 px of drift, G11 pre-fix).
2. **An `overflow: auto` ancestor** — scrolling the container moves the text
   relative to the document without changing `window.scrollY`, and *nothing*
   observes it: MutationObserver sees no record, the layout-shift
   PerformanceObserver excludes scroll by definition, and there are no
   transition events (measured 400–472 px drift, G12/G13/G14 pre-fix).

Sticky is the interesting middle case: a stuck element visually stays put
while the document moves, which Chromium **does** report as a layout-shift
entry — so the existing observer already repositioned sticky content (G10
passed pre-fix). That asymmetry (scroll excluded from layout-shift for
viewports but not for stuck elements) is why fixed and inner-scroll needed a
fix while sticky did not.

The fix keeps the "no scroll listeners" spirit for the 99% case: entries are
classified at scan time as viewport-anchored or scroller-anchored, and only
that subset is repositioned on scroll events — rAF-throttled, ≥50 ms apart,
with one settle pass. No polling, no per-event full traversal.

## MV3 service worker lifecycle

The SW is killed by Chrome after ~30 s idle; any message cold-starts it.
Everything the audit asserts about races must therefore hold across cold
starts: handlers are stateless, the only persistence is
`chrome.storage.session`, and the in-flight dedup map dying with the worker
is harmless (worst case: one duplicate fetch). The suites prove the practical
consequences: a resolve issued into a dead channel restarts the worker and
succeeds (M5b), a resolve that outlives its tab doesn't poison anything (M8),
and malformed messages can't crash the worker (M2).

One honest harness note: idle termination itself cannot be observed under a
CDP-attached harness — an attached DevTools-equivalent session disables MV3
idle shutdown, and `stopAllWorkers`/`closeTarget` proved ineffective. So the
restart property is covered by cold-start tests and `chrome.runtime.reload()`
(M5), and storage persistence across termination rests on Chrome's documented
session-scoped guarantee (LIMIT-1 in report.md).

## The storage.session trade-off

`storage.session` is the only state that survives SW death but never touches
disk and clears when the browser session ends — privacy (nothing about your
browsing persists) and freshness (balances re-fetch next session) for free.
The audit verified the trade from both sides: the **upside** — identity
fields + balance survive a worker restart, so a re-hover after restart skips
the RPC wave (C1) and the TTL-refresh path updates only the balance
(S5/M5-pre chain) — and the **boundary** — after `chrome.runtime.reload()`
the session storage is correctly empty and the next resolve does a real RPC
round trip (M5/M5c: fresh value, no ghost cache). The alternative (an
in-memory Map) was measured in the baseline design: the worker dies every
~30 s, so it would be a cache that doesn't cache.

## How stale responses are prevented from overwriting new focus

Every layer refuses to commit stale data:
- **Hover controller**: hovering B cancels A's intent/scan timers and hides
  the card before B's sequence starts; A's card never renders after the
  pointer moved on (the audit's M6 race: A delayed 2.5 s, B fast — final card
  is B's, A's text never appears).
- **React layer**: each `HoverCard` binds to its own `profileRequest` with an
  `alive` flag; an unmounted card drops its response (M7: response after
  close reopens nothing).
- **Side panel**: focus is handed through `storage.session` (`lens:focus`),
  which the panel watches — last write wins, and a reload restores the last
  focus (M9).
- **Background**: responses carry the resolved identity's profile; nothing
  global is mutated, so a late `sendResponse` can only reach a channel whose
  requester still cares.

## How RPC URLs and keys are kept out of the UI

Three locks: (1) the SW maps every failure to a fixed code
(`RPC_TIMEOUT | RPC_UNREACHABLE | LOOKUP_FAILED | NAME_NOT_FOUND`) before it
crosses the message boundary — `toErrorCode` never forwards messages; (2)
`redactError` strips `https?://…` from anything written to the console; (3)
the card renders only codes, in an open shadow root the host page could
read. The audit attacked each path with hostile payloads — a JSON-RPC error
message containing a fake key and provider URL, HTTP 500 bodies, non-JSON
HTML — and asserted the card text contains only the code and none of the
hostile material (R1–R5, R8, plus leak asserts per scenario). The fetch
whitelist is the last lock: even a successful OffchainLookup escalation would
be refused at `fetch` (R9: zero gateway hits).

## EIP-7702 delegated EOA classification

`classifyBytecode` treats three shapes: no code / `0x` → EOA;
exactly `0xef0100 ‖ 20-byte address` (48 hex chars) → **EOA with delegation**
(never CONTRACT, delegate target surfaced as `DELEGATE` row); anything else →
CONTRACT. The audit pinned the boundary cases against the mock RPC: a correct
designator renders `EOA · 7702` with the delegate address (B2), and a
malformed designator — right prefix, wrong length — degrades to CONTRACT
(B3). Vitalik's mainnet account currently carries a live 7702 delegation, and
the real-chain suite (card.mjs) asserts the chip through the actual pipeline.

## A real browser problem found by testing

**Scroll-anchored highlight drift.** The product's central design note said
"page-absolute overlay ⇒ scrolling needs no listeners". The audit proved that
claim true for normal flow and *false at the edges*: a fixed element drifted
3267 px under window scroll and addresses inside `overflow:auto` containers
drifted 400–472 px on inner scroll, because Chromium fires no event the
product listened to for either case. Sticky turned out to be silently covered
by the layout-shift PerformanceObserver. The fix (scroll-anchor classification
+ throttled subset reposition) removed all drift with a per-scroll cost of
one `Set.size` check on pages without scroll-sensitive matches — and the
whole geometry suite now asserts ≤1.5 px everywhere. (Second finding worth
naming: viem silently retries `TimeoutError`, turning a 12 s timeout into a
~49 s skeleton — found by timing a mocked hang, fixed with `retryCount: 0`.)

## A performance-vs-correctness trade-off

The scroll fix had to choose: reposition *everything* on every scroll event
(correct, but a 500-match explorer table would pay ~hundreds of
`Range.getClientRects()` calls per frame — jank), reposition on a fixed
polling cadence (smooth, but constant background work the product's design
forbids), or **classify and subset** (pay a one-time ancestor walk per match
at scan time, then only scroll-sensitive entries reposition, throttled to
~20 passes/s plus one settle pass). The audit took the third option and
measured both sides: correctness — all scroll scenarios at 0.00 px drift —
and cost — pages without scroll-sensitive matches do no work at all on
scroll, and the perf suite shows scan time unchanged (10k nodes/500 matches:
499 ms wall for the full initial scan, churn tests leak-free). The residual
accepted cost: the anchor classification can go stale if an element *becomes*
fixed/sticky later via class changes — the next full reposition pass
(attribute/transition/layout-shift driven) refreshes it, bounded by the same
debounces that already govern geometry updates.
