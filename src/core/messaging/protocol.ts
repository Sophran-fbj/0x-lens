import type { Address } from '../address';

/**
 * Message protocol between content script / side panel and the background
 * service worker. The background is the ONLY place that talks RPC; every
 * handler must be idempotent because the MV3 service worker can be killed
 * between any two messages.
 */

/** ERC-20-style metadata probed via multicall when the address is a contract.
 *  Presence does NOT prove ERC-20 compliance — many contracts expose the same
 *  selectors. UI renders it as `TOKEN · SYM`, never as a verified claim. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
}

export interface AddressProfile {
  address: Address;
  ensName: string | null;
  /** Wei as a decimal string — bigint does not survive JSON messaging. */
  ethBalanceWei: string;
  isContract: boolean;
  /**
   * EIP-7702 delegation target, when the address is an EOA whose bytecode is
   * a `0xef0100 || address` designator (common since Pectra). Such addresses
   * stay EOA-classified — they are NOT contracts.
   */
  eoaDelegation: Address | null;
  tokenMetadata: TokenMetadata | null;
  fetchedAt: number;
}

export type LensMessage =
  | { type: 'lens/resolve'; address: Address }
  | { type: 'lens/openPanel'; address: Address };

export type LensResponse =
  | { ok: true; profile: AddressProfile }
  | { ok: false; error: string };

/** openPanel responds immediately — opening the panel is fire-and-forget. */
export type OpenPanelResponse = { ok: boolean; error?: string };
