# 0x Lens

> Hover any Ethereum address on the web to reveal its onchain identity.

Chrome extension · Manifest V3 · Ethereum mainnet.

![hover demo](docs/hover.gif)

An address appears in an article, a post-mortem, a commit thread. You hover
it: it lights up, a scan line sweeps across it — *the scan is the loading
state* — and an identity card unfolds: ENS, ETH balance, EOA / contract /
token, and (since Pectra) EIP-7702 delegation. Click to open the Side Panel
for the full readout.

![panel demo](docs/panel.gif)

## Principles

- **No wallet, no onboarding, no accounts.** Install and browse.
- **No third-party APIs, no backend, no telemetry.** Ethereum JSON-RPC is the
  only data source; nothing ever leaves the browser except address lookups to
  your RPC endpoint. No page content is transmitted.
- **The host page is never modified.** Highlights are computed from
  `Range.getClientRects()` and painted in an isolated Shadow DOM overlay —
  React/Vue reconciliation on the page can never see us.
- **It's a lens, not an explorer.** Etherscan is one click away for anything
  deeper.

## What it reads

| | |
|---|---|
| ENS | reverse resolution (pure RPC via the universal resolver) |
| Balance | `eth_getBalance`, formatted without float math |
| Account type | bytecode: none → **EOA**; `0xef0100‖addr` → **EOA with EIP-7702 delegation** (still an EOA, delegate shown); else **CONTRACT** |
| Token metadata | contracts probed once via Multicall3 (`name`/`symbol`/`decimals`); renders as `TOKEN · USDC`, never claims verified ERC-20 compliance |
| Empty state | zero-balance, nameless, contractless → *NO ON-CHAIN FOOTPRINT* |

Detection: `/\b0x[a-fA-F0-9]{40}\b/g` with EIP-55 checksum enforcement for
mixed-case strings (all-lower/upper accepted). Known honest misses: truncated
`0x1234…abcd` forms, and old tokens whose `name()` returns `bytes32` (MKR)
degrade to plain CONTRACT.

## Measured numbers

Scanning (real pages, initial scan, idle-chunked off the critical path):

| Page | Text nodes | Highlights | Scan time |
|---|---|---|---|
| Test rig (150+ address stress) | 166 | 161 | ~300 ms |
| etherscan.io token page | 492 | 0 (visible addresses are truncated; full ones live in `<script>` payloads, deliberately never scanned) | 13 ms |
| Wikipedia · Ethereum | 304 | 0 | 90 ms |

Hover → data: first hover ≈ 1.7–2.3 s end-to-end (includes the 550 ms
acquire animation + one RPC round trip to a public endpoint); re-hover of a
scanned address ≈ **0.22–0.27 s** from cache, skipping the scan ceremony.

## Architecture

```
Content Script (top frame)             Background SW               Side Panel
  scanner: TreeWalker + regex    ───▶  viem publicClient      ◀──  React page
  + EIP-55 validation                   batch:true (identity      storage.watch
  overlay: Range rects →                = one JSON-RPC batch)      on session:lens:focus
  Shadow DOM, zero DOM mutation         storage.session cache
  hover card: Shadow DOM +              (balance TTL 60s,
  Framer Motion                          identity session-permanent)
```

Engineering notes worth reading (all verified by e2e, not aspiration):

- **Zero-mutation annotation** — page-absolute overlay coordinates mean
  scrolling needs no listeners; MutationObserver (debounced batches) +
  WeakSet dedup + a 500-match cap handle SPA churn and explorer tables.
- **Two-wave data pipeline** — `Promise.all(balance, bytecode, ensName)` then,
  for contracts, a token-metadata multicall. The card's reveal choreography
  maps 1:1 onto the real fetch stages; the scan line's duration is tuned to
  RPC latency so the animation *is* the loading state.
- **MV3 service-worker reality** — the SW dies constantly; all state lives in
  `chrome.storage.session`, messages are idempotent, and concurrent lookups
  coalesce in-flight.
- **The side-panel gesture path** — `sidePanel.open()` is the first statement
  of its message branch (no awaits before it); the user-gesture window
  through message passing is ~1 ms in the worst reported cases.

## Permissions

`storage`, `sidePanel`, plus exactly one host permission: your RPC endpoint's
origin (derived from `VITE_RPC_URL`, or viem's default). Content-script
injection uses `matches`; no `tabs`, no `scripting`, no remote code.

## Dev

Requires Node 20+ and a Chromium-family browser (e2e uses the system Edge
channel).

```sh
npm install
npm run fixture        # test rig + article page on localhost:5173
npm run dev            # WXT dev (note: HMR breaks on strict-CSP sites — iterate on the fixture)
npm run build          # production build → .output/chrome-mv3 (load unpacked)
```

Test suite (needs the fixture server + a fresh build):

```sh
node e2e/verify.mjs    # detection layer: 7/7
node e2e/rpc.mjs       # data pipeline against real mainnet: 10/10
node e2e/card.mjs      # hover card over the real message path: 9/9
node e2e/panel.mjs     # side panel + gesture open path: 9/9
node e2e/perf.mjs      # real-site scan measurements
node e2e/demo.mjs && node e2e/convert.mjs   # regenerate docs/*.gif
```

Tip: persistent browser profiles cache old service workers — delete
`.playwright-profile` when background changes seem to not apply.

## Roadmap (V2 ideas, deliberately not built)

ENS forward resolution for `.eth` names · truncated-address recovery via
ancestor `href` · multi-chain (Base/Arbitrum) · viewport-bounded prefetch ·
USD pricing · per-site enablement UX · keyboard access for highlights.

## License

MIT
