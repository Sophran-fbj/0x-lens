import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';

/**
 * The single viem client. Lives only in the background service worker —
 * content scripts and the side panel go through the message protocol.
 *
 * Endpoint resolution mirrors wxt.config.ts (VITE_RPC_URL or viem's default),
 * so the host_permissions entry always matches the URL actually used.
 */

const rpcUrl =
  (import.meta.env.VITE_RPC_URL as string | undefined) ?? mainnet.rpcUrls.default.http[0]!;

export const publicClient = createPublicClient({
  chain: mainnet,
  // batch: true — the three concurrent identity calls (balance/bytecode/ens)
  // leave as ONE JSON-RPC batch POST instead of three HTTP requests.
  transport: http(rpcUrl, { batch: true }),
});
