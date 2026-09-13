import { browser } from 'wxt/browser';
import type { Address } from '@/core/address';
import type { LensMessage, LensResponse } from '@/core/messaging/protocol';
import { resolveProfile } from '@/core/services/resolve';

async function handleResolve(address: Address): Promise<LensResponse> {
  try {
    const profile = await resolveProfile(address);
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function handleMessage(
  msg: unknown,
  _sender: unknown,
  sendResponse: (response: LensResponse) => void,
): boolean {
  const message = msg as LensMessage;
  if (message?.type === 'lens/resolve') {
    handleResolve(message.address).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  // 'lens/openPanel' lands in Phase 4 — see the gesture rule below.
  return false;
}

export default defineBackground(() => {
  // Stable fallback: the toolbar icon always opens the panel.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[0x Lens] setPanelBehavior failed:', err));

  browser.runtime.onMessage.addListener(handleMessage);

  // ⚠️ Gesture rule (CLAUDE.md): when the 'lens/openPanel' branch is added in
  // Phase 4, sidePanel.open() must be the FIRST statement of that branch — no
  // awaits, no animation ticks. The user-gesture window through message
  // passing is ~1ms in the worst reported cases.
});
