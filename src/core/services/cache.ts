import { storage } from 'wxt/utils/storage';
import type { Address } from '../address';
import type { AddressProfile } from '../messaging/protocol';

/**
 * Per-address profile cache in chrome.storage.session.
 *
 * Why storage.session (Locked Decision): it survives service-worker restarts
 * (an in-memory Map would die every ~30s of idleness) but never touches disk
 * and clears when the browser closes — the right freshness/privacy trade.
 * It is also invisible to content scripts by default, which we want.
 */

const key = (address: Address): `session:lens:p:${string}` =>
  `session:lens:p:${address.toLowerCase()}`;

export function cacheGet(address: Address): Promise<AddressProfile | null> {
  return storage.getItem<AddressProfile>(key(address));
}

export function cacheSet(address: Address, profile: AddressProfile): Promise<void> {
  return storage.setItem(key(address), profile);
}
