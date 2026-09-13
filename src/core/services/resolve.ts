import { LensError } from '../errors';
import type { AddressProfile } from '../messaging/protocol';
import { cacheGet, cacheSet } from './cache';
import { publicClient } from './chain';
import { fetchProfile } from './profile';

/**
 * resolveIdentity — the background's single read path for an identity
 * (checksummed address, or ENS name for forward lookup).
 *
 * Locked Decision: this is one helper + one TTL constant. No cache framework.
 *
 * TTL semantics:
 * - identity fields (ensName, isContract, tokenMetadata) are permanent for
 *   the browser session — they effectively never change;
 * - ethBalance goes stale after BALANCE_TTL_MS → refresh balance ONLY,
 *   never the identity pipeline.
 *
 * In-flight coalescing: concurrent hovers on the same identity share one
 * promise (the map lives in SW memory; dying with the SW is harmless).
 */

const BALANCE_TTL_MS = 60_000;

const inflight = new Map<string, Promise<AddressProfile>>();

export function resolveIdentity(identity: string): Promise<AddressProfile> {
  const key = identity.toLowerCase();
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = resolveUncached(identity).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function resolveUncached(identity: string): Promise<AddressProfile> {
  // ENS forward lookup: name → address, then the normal pipeline.
  // (ccipRead is disabled client-wide; names on offchain resolvers will
  // surface as LOOKUP_FAILED — an accepted, privacy-consistent miss.)
  if (!identity.startsWith('0x')) {
    const address = await publicClient.getEnsAddress({ name: identity });
    if (!address) throw new LensError('NAME_NOT_FOUND');
    const profile = await resolveAddress(address);
    // The queried name is authoritative for display even when the address
    // has no reverse record.
    if (!profile.ensName) return { ...profile, ensName: identity };
    return profile;
  }
  return resolveAddress(identity as `0x${string}`);
}

async function resolveAddress(address: `0x${string}`): Promise<AddressProfile> {
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
