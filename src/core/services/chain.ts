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
const rpcOrigin = new URL(rpcUrl).origin;

export const publicClient = createPublicClient({
  chain: mainnet,
  // Privacy (Locked Decision): the RPC endpoint is the ONLY host we ever
  // talk to. CCIP-Read is disabled so an offchain ENS resolver cannot make
  // viem fetch resolver-specified third-party gateways.
  ccipRead: false,
  // batch: true — the three concurrent identity calls (balance/bytecode/ens)
  // leave as ONE JSON-RPC batch POST instead of three HTTP requests.
  // timeout: a hung connection (bad routing, dropped TCP) surfaces as
  // RPC_TIMEOUT instead of an eternal skeleton.
  transport: http(rpcUrl, {
    batch: true,
    timeout: 12_000,
    // viem retries TimeoutError and 5xx/429 by default (3 more attempts) —
    // a hung connection would then hold the card skeleton for ~4×12s before
    // surfacing anything. One attempt, then the stable RPC_TIMEOUT code: the
    // user can re-hover (and the stale-balance path still covers hiccups).
    retryCount: 0,
  }),
});

/**
 * Mechanical enforcement of the same promise: every fetch the service worker
 * issues must target the RPC origin. Guards future code paths (new viem
 * actions, V2 features) against quietly phoning elsewhere — and makes the
 * README's "nothing leaves except address lookups to your RPC endpoint"
 * structurally true rather than aspirational.
 */
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const origin = new URL(url, self.location.href).origin;
  if (origin !== rpcOrigin) {
    return Promise.reject(new Error(`[0x Lens] blocked non-RPC fetch to ${origin}`));
  }
  return nativeFetch(input as RequestInfo, init);
}) as typeof fetch;
