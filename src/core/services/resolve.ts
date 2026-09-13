import type { Address } from '../address';
import type { AddressProfile } from '../messaging/protocol';
import { cacheGet, cacheSet } from './cache';
import { publicClient } from './chain';
import { fetchProfile } from './profile';

/**
 * resolveProfile — the background's single read path for an address.
 *
 * Locked Decision: this is one helper + one TTL constant. No cache framework.
 *
 * TTL semantics:
 * - identity fields (ensName, isContract, tokenMetadata) are permanent for
 *   the browser session — they effectively never change;
 * - ethBalance goes stale after BALANCE_TTL_MS → refresh balance ONLY,
 *   never the identity pipeline.
 *
 * In-flight coalescing: concurrent hovers on the same address share one
 * promise (the map lives in SW memory; dying with the SW is harmless).
 */

const BALANCE_TTL_MS = 60_000;

const inflight = new Map<string, Promise<AddressProfile>>();

export function resolveProfile(address: Address): Promise<AddressProfile> {
  const key = address.toLowerCase();
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = resolveUncached(address).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function resolveUncached(address: Address): Promise<AddressProfile> {
  const cached = await cacheGet(address);
  if (cached) {
    if (Date.now() - cached.fetchedAt < BALANCE_TTL_MS) return cached;
    // Balance stale, identity permanent → single getBalance, keep the rest.
    try {
      const balance = await publicClient.getBalance({ address });
      const refreshed: AddressProfile = {
        ...cached,
        ethBalanceWei: balance.toString(),
        fetchedAt: Date.now(),
      };
      await cacheSet(address, refreshed);
      return refreshed;
    } catch {
      return cached; // a stale balance beats an error card
    }
  }

  const profile = await fetchProfile(address);
  await cacheSet(address, profile);
  return profile;
}
