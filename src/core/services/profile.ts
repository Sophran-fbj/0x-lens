import type { Address } from '../address';
import type { AddressProfile } from '../messaging/protocol';
import { publicClient } from './chain';
import { probeTokenMetadata } from './token';

/**
 * Full identity pipeline — deliberately two waves, because the hover card's
 * reveal animation maps 1:1 onto them (CLAUDE.md):
 *
 *   wave 1  SCAN        Promise.all(balance, bytecode, ensName)
 *   wave 2  ANALYZE     real contract? → multicall token metadata
 */

const EIP7702_PREFIX = '0xef0100';
const EIP7702_DESIGNATOR_LENGTH = '0xef0100'.length + 40; // indicator + 20-byte address

/**
 * Bytecode → account type. Three outcomes on current mainnet:
 * - no code (viem returns undefined; some nodes '0x')          → EOA
 * - `0xef0100 ‖ address` designator (23 bytes)                 → EOA with an
 *   EIP-7702 delegation — still an EOA, never a CONTRACT
 * - anything else                                              → CONTRACT
 */
export function classifyBytecode(bytecode: string | undefined): {
  isContract: boolean;
  eoaDelegation: Address | null;
} {
  if (!bytecode || bytecode === '0x') return { isContract: false, eoaDelegation: null };
  if (
    bytecode.length === EIP7702_DESIGNATOR_LENGTH &&
    bytecode.toLowerCase().startsWith(EIP7702_PREFIX)
  ) {
    return { isContract: false, eoaDelegation: ('0x' + bytecode.slice(8)) as Address };
  }
  return { isContract: true, eoaDelegation: null };
}

export async function fetchProfile(address: Address): Promise<AddressProfile> {
  const [balance, bytecode, ensName] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.getBytecode({ address }),
    publicClient.getEnsName({ address }),
  ]);

  const { isContract, eoaDelegation } = classifyBytecode(bytecode);
  const tokenMetadata = isContract ? await probeTokenMetadata(address) : null;

  return {
    address,
    ensName: ensName ?? null,
    // bigint does not survive JSON messaging — serialize as decimal string.
    ethBalanceWei: balance.toString(),
    isContract,
    eoaDelegation,
    tokenMetadata,
    fetchedAt: Date.now(),
  };
}
