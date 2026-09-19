# Nightly Audit Baseline — 0x-lens

Recorded: 2026-09-19 (local time)

## Repository state

- Baseline commit SHA: `6b63c3b195cd80356f301c5dd2c41182a27d5aba`
- Baseline branch: `main` (clean working tree, up to date with origin/main)
- Audit branch: `agent/nightly-0x-audit` (created from baseline; local only, never pushed)

## Environment

| Item | Value |
|---|---|
| OS | Windows 10 Pro (10.0.26200 x64, win32) |
| Node | v20.19.4 |
| Package manager | npm (package-lock present; deps already installed) |
| Browser (local e2e) | System Microsoft Edge channel (`channel: 'msedge'` in e2e/browser.mjs); UA reports Chrome/153.0.0.0 Edg/153.0.0.0; CI parity browser is Playwright Chromium (`OXL_E2E_BROWSER=chromium`) |
| Edge version | 153.0.0.0 (from navigator.userAgent of the extension test context) |
| Fixture | `npm run fixture` → vite on http://localhost:5173 (task rule: port 5173 only; 3100 belongs to another project and is never used) |
| Test concurrency | ≤ 2 browser contexts; sequential e2e scripts (no watch mode) |

## Baseline command results (at 6b63c3b)

| Command | Result | Notes |
|---|---|---|
| `npm run compile` (tsc --noEmit) | PASS | clean, no output |
| `npm run build` (wxt build) | PASS | 8.15s, total 911.61 kB → `.output/chrome-mv3` |
| `node e2e/verify.mjs` (detection, offline) | PASS 31/31 | fixture on 5173, system Edge |
| `node e2e/rpc.mjs` (real mainnet) | PASS 10/10 | endpoint `https://ethereum.reth.rs/rpc`; wave1 1299ms, wave2 473ms; vitalik is currently 7702-delegated (`0x5a7f…f6d`) |
| `node e2e/card.mjs` (hover card) | PASS 11/11 | real mainnet |
| `node e2e/panel.mjs` (side panel) | PASS 10/10 | real mainnet; SW fetch-guard block asserted |
| `node e2e/perf.mjs` (perf measurement) | PASS | fixture 298 nodes/175 matches/141ms; etherscan 2199/4/23ms; wikipedia 2280/0/24ms; x.com 66/7/25ms |

No pre-existing failures found at baseline.

## Baseline manifest permissions (must not change)

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "sidePanel"],
  "host_permissions": ["https://ethereum.reth.rs/*"],
  "content_scripts": [{ "matches": ["<all_urls>"], "run_at": "document_idle" }]
}
```

No `tabs`, no `scripting`, no broad host permissions, no remote code.

## Existing test inventory (per README)

- e2e/verify.mjs — 31 offline detection checks
- e2e/rpc.mjs — 10 RPC pipeline checks (real mainnet)
- e2e/card.mjs — 11 hover-card checks (real mainnet)
- e2e/panel.mjs — 10 side-panel checks (real mainnet)
- e2e/perf.mjs — scan measurements on real pages
- CI (.github/workflows/ci.yml): compile + build + `OXL_E2E_BROWSER=chromium node e2e/verify.mjs` on ubuntu-latest, Node 22

## Notes

- `.env` handling: VITE_RPC_URL optional; repo default is viem's public mainnet endpoint
  (`https://ethereum.reth.rs`). No secret values are ever read, printed, or committed by this audit.
- `.playwright-profile/` holds the persistent test profile (cached SW hazard; delete only if
  background changes stop applying — it is gitignored).
