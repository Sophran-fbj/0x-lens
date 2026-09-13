import { getAddress } from 'viem';

export type Address = `0x${string}`;

/**
 * A full Ethereum address: 0x followed by exactly 40 hex chars.
 *
 * - `\b` on both sides prevents matching inside longer hex runs (the first 40
 *   chars of a 64-char tx hash, `0x…n` BigInt literals, …).
 * - Truncated forms (`0x1234…abcd`) intentionally do NOT match — the full
 *   address is not recoverable from them.
 */
export const ETH_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

/**
 * Validate a raw `0x` + 40-hex string and return its checksummed form.
 *
 * Policy (CLAUDE.md · 检测规则):
 * - Mixed-case hex MUST pass the EIP-55 checksum — this filters most
 *   random-identifier false positives.
 * - All-lowercase or all-uppercase hex is accepted as-is (too common in the
 *   wild to reject). Residual false positives (random lowercase hex ids) are
 *   handled gracefully by the card's "no on-chain footprint" empty state.
 */
export function parseAddress(raw: string): Address | null {
  let checksummed: Address;
  try {
    checksummed = getAddress(raw);
  } catch {
    return null; // wrong length or non-hex
  }
  const isMixedCase = /[a-f]/.test(raw) && /[A-F]/.test(raw);
  if (isMixedCase && raw !== checksummed) return null; // failed EIP-55
  return checksummed;
}
