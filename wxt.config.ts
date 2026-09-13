import { defineConfig } from 'wxt';

// See CLAUDE.md "Locked Decisions" before changing anything here.
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '0x Lens',
    version: '0.1.0',
    description: 'Hover any Ethereum address on the web to reveal its onchain identity.',
    // RPC endpoint origin is appended here in Phase 2 (host_permissions),
    // derived from VITE_RPC_URL. Content script injection itself needs no
    // host_permissions — matches in defineContentScript is sufficient.
    permissions: ['storage', 'sidePanel'],
  },
});
