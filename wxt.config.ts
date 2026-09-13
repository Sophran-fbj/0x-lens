import fs from 'node:fs';
import { mainnet } from 'viem/chains';
import { defineConfig } from 'wxt';

/**
 * RPC endpoint resolution — single source shared with src/core/services/chain.ts:
 * VITE_RPC_URL (env or .env) if set, otherwise viem's default mainnet RPC.
 * The manifest host_permissions entry is derived from it (Locked Decision:
 * network access is granted to the RPC origin only, nothing else).
 */
function resolveRpcUrl(): string {
  if (process.env.VITE_RPC_URL) return process.env.VITE_RPC_URL;
  try {
    const raw = fs.readFileSync('.env', 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*VITE_RPC_URL\s*=\s*(.+?)\s*$/);
      if (m) return m[1]!;
    }
  } catch {
    /* no .env file */
  }
  return mainnet.rpcUrls.default.http[0]!;
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '0x Lens',
    version: '0.1.0',
    description: 'Hover any Ethereum address on the web to reveal its onchain identity.',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [`${new URL(resolveRpcUrl()).origin}/*`],
  },
});
