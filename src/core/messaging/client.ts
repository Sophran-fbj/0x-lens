import { browser } from 'wxt/browser';
import type { Address } from '../address';
import type { LensResponse } from './protocol';

/** Content-script / side-panel side of the protocol. All RPC stays in the
 *  background — this is the only door. */
export function requestProfile(address: Address): Promise<LensResponse> {
  return browser.runtime.sendMessage({ type: 'lens/resolve', address });
}
