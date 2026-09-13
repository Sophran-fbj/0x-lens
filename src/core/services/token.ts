import { erc20Abi, type Address } from 'viem';
import type { TokenMetadata } from '../messaging/protocol';
import { publicClient } from './chain';

/**
 * Probe a contract for ERC-20-style metadata via one Multicall3 call.
 *
 * A success here does NOT prove ERC-20 compliance (any contract can expose
 * these selectors) — the UI renders `TOKEN · SYM`, never a verified claim.
 * Known accepted miss: old tokens whose name()/symbol() return bytes32
 * (e.g. MKR) fail string decoding here and degrade to a plain CONTRACT.
 */

const MAX_REASONABLE_DECIMALS = 36;
const MAX_NAME_LEN = 64;
const MAX_SYMBOL_LEN = 32;

export async function probeTokenMetadata(address: Address): Promise<TokenMetadata | null> {
  let results;
  try {
    results = await publicClient.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: erc20Abi, functionName: 'name' },
        { address, abi: erc20Abi, functionName: 'symbol' },
        { address, abi: erc20Abi, functionName: 'decimals' },
      ],
    });
  } catch {
    return null; // no Multicall3 support / RPC failure → plain CONTRACT
  }

  const [name, symbol, decimals] = results;
  if (!name || !symbol || !decimals) return null;
  if (name.status !== 'success' || symbol.status !== 'success' || decimals.status !== 'success') {
    return null;
  }

  const n = name.result?.trim();
  const s = symbol.result?.trim();
  const d = decimals.result;
  // Garbage filters: non-token contracts can return empty or absurd values.
  if (!n || !s || n.length > MAX_NAME_LEN || s.length > MAX_SYMBOL_LEN) return null;
  if (typeof d !== 'number' || d < 0 || d > MAX_REASONABLE_DECIMALS) return null;

  return { name: n, symbol: s, decimals: d };
}
