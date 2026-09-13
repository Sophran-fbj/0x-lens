import type { Address } from '../address';
import type { LensErrorCode } from '../errors';

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

/**
 * Identity is a DISCRIMINATED union, not a bare string — ENS labels may
 * legally start with `0x` (e.g. `0xdead.eth`), so type routing must come
 * from the scanner's knowledge, never from `startsWith('0x')`.
 */
export type LensIdentity =
  | { kind: 'address'; address: Address }
  | { kind: 'name'; name: string };

export function identityKey(id: LensIdentity): string {
  return id.kind === 'address' ? id.address.toLowerCase() : id.name.toLowerCase();
}

export type LensMessage =
  | { type: 'lens/resolve'; identity: LensIdentity }
  | { type: 'lens/openPanel'; identity: LensIdentity };

export type LensResponse =
  | { ok: true; profile: AddressProfile }
  /** Stable error CODE (see core/errors.ts) — never a raw RPC message:
   *  those can embed the RPC URL with API keys, and the card renders into
   *  an open shadow root the host page can read. */
  | { ok: false; error: LensErrorCode };

/** openPanel responds immediately — opening the panel is fire-and-forget. */
export type OpenPanelResponse = { ok: boolean; error?: string };
