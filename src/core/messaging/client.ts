import { browser } from 'wxt/browser';
import type { Address } from '../address';
import type { LensResponse } from './protocol';

/** Content-script / side-panel side of the protocol. All RPC stays in the
 *  background — this is the only door. */
export function requestProfile(address: Address): Promise<LensResponse> {
  return browser.runtime.sendMessage({ type: 'lens/resolve', address });
}

/**
 * Open the side panel for this tab, focused on `address`.
 * GESTURE RULE: call this as the FIRST statement of a click handler — the
 * user-gesture window through message passing is ~1ms in the worst case.
 * Fire-and-forget by design.
 */
export function openLens(address: Address): void {
  void browser.runtime.sendMessage({ type: 'lens/openPanel', address }).catch(() => {});
}
