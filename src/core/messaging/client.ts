import { browser } from 'wxt/browser';
import type { LensIdentity, LensResponse } from './protocol';

/** Content-script / side-panel side of the protocol. All RPC stays in the
 *  background — this is the only door. */
export function requestProfile(identity: LensIdentity): Promise<LensResponse> {
  return browser.runtime.sendMessage({ type: 'lens/resolve', identity });
}

/**
 * Open the side panel for this tab, focused on `identity`.
 * GESTURE RULE: call this as the FIRST statement of a click handler — the
 * user-gesture window through message passing is ~1ms in the worst case.
 * Fire-and-forget by design.
 */
export function openLens(identity: LensIdentity): void {
  void browser.runtime.sendMessage({ type: 'lens/openPanel', identity }).catch(() => {});
}
