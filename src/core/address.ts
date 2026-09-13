import { getAddress } from 'viem';

export type Address = `0x${string}`;

/**
 * A full Ethereum address: 0x followed by exactly 40 hex chars.
 *
 * - `\b` on both sides prevents matching inside longer hex runs (the first 40
 *   chars of a 64-char tx hash, `0x…n` BigInt literals, …).
 * - Truncated forms (`0x1234…abcd`) intentionally do NOT match directly — the
 *   full address is not recoverable from the text alone. They are recovered
 *   via the ancestor <a> href when one exists (see parseTruncatedCandidate).
 */
export const ETH_ADDRESS_RE = /\b0x[a-fA-F0-9]{40}\b/g;

/**
 * Truncated display form: `0x` + 4-8 hex + ellipsis (… or ...) + 4-8 hex.
 * Matches must be validated against a link href before use.
 */
export const TRUNCATED_ADDRESS_RE = /\b0x[a-fA-F0-9]{4,8}(?:…|\.\.\.)[a-fA-F0-9]{4,8}\b/g;

/**
 * ENS name in prose — full multi-level form: one or more ASCII labels
 * (1-61 chars, no leading/trailing hyphen) ending in `.eth`.
 *
 * The lookbehind `(?<![\w.@-])` is load-bearing: it forbids starting a
 * match after a dot (so `sub.vitalik.eth` can never partially match as
 * `vitalik.eth` — it matches whole or not at all) and after `@` or a word
 * char (so email domains like `user@mail.foo.eth` never match, even when
 * the domain has multiple labels). Unicode/emoji names are a deliberate
 * V1.5 non-goal (ENSIP-15 normalization).
 */
export const ENS_NAME_RE = /(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]{0,59}[a-z0-9])?\.)+eth\b/gi;

/** A full 0x{40} address extracted from an href string, EIP-55 checked.
 *  Lowercase/all-uppercase hex accepted per the address policy. */
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

export interface TruncatedCandidate {
  prefix: string;
  suffix: string;
}

/** Validate a truncated-form match and return its prefix/suffix (lowercased). */
export function parseTruncatedCandidate(raw: string): TruncatedCandidate | null {
  const m = raw.match(/^0x([a-fA-F0-9]{4,8})(?:…|\.\.\.)([a-fA-F0-9]{4,8})$/);
  if (!m) return null;
  return { prefix: m[1]!.toLowerCase(), suffix: m[2]!.toLowerCase() };
}

/** Recover a full address from an href, enforcing that it is consistent with
 *  the visible truncated text (same start, same end). Hrefs can contain
 *  SEVERAL addresses (e.g. `/token/0xTOKEN?a=0xHOLDER`) — the first
 *  consistent one wins, not just the first one found. */
export function recoverFromHref(
  href: string | null,
  cand: TruncatedCandidate,
): Address | null {
  if (!href) return null;
  for (const m of href.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)) {
    const address = parseAddress(m[0]);
    if (!address) continue;
    const lower = address.toLowerCase();
    if (lower.startsWith(`0x${cand.prefix}`) && lower.endsWith(cand.suffix)) return address;
  }
  return null;
}

/** Validate + canonicalize an ENS name candidate (lowercase ASCII,
 *  multi-level labels allowed). */
export function parseEnsName(raw: string): string | null {
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,59}[a-z0-9])?\.)+eth$/.test(raw.toLowerCase())) return null;
  return raw.toLowerCase();
}
