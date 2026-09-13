# 0x Lens

> Hover any Ethereum address on the web to reveal its onchain identity.

Chrome extension (Manifest V3). Status: **Phase 1 — detection layer**.

Hover an address → it lights up → a scan line sweeps across it (the scan *is*
the loading state) → an identity card unfolds: ENS, ETH balance, EOA /
contract / token. Click to open the Side Panel for the full report.

- No wallet connection, no onboarding, no third-party APIs, no backend, no
  telemetry — Ethereum mainnet RPC is the only data source.
- The host page's DOM is never modified: highlights are computed from
  `Range.getClientRects()` and rendered in an isolated Shadow DOM overlay.

See [CLAUDE.md](./CLAUDE.md) for the locked product/engineering decisions.

## Dev

```sh
npm install
npm run fixture   # test rig on localhost:5173
npm run dev       # WXT dev → load .output/chrome-mv3 as unpacked extension
npm run build     # production build
```
