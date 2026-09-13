import { browser } from 'wxt/browser';
import { storage } from 'wxt/utils/storage';
import type { Address } from '@/core/address';
import type { LensMessage, LensResponse, OpenPanelResponse } from '@/core/messaging/protocol';
import { resolveProfile } from '@/core/services/resolve';

async function handleResolve(address: Address): Promise<LensResponse> {
  try {
    const profile = await resolveProfile(address);
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** All we need from the runtime sender for sidePanel targeting. */
interface TabSender {
  tab?: { id?: number };
}

function handleMessage(
  msg: unknown,
  sender: TabSender,
  sendResponse: (response: LensResponse | OpenPanelResponse) => void,
): boolean {
  const message = msg as LensMessage;
  if (message?.type === 'lens/resolve') {
    handleResolve(message.address).then(sendResponse);
    return true; // keep the channel open for the async response
  }
  if (message?.type === 'lens/openPanel') {
    // ⚠️ GESTURE RULE (CLAUDE.md): sidePanel.open() must be the FIRST
    // effectful statement of this branch — no awaits, no animation ticks
    // before it. The user-gesture window through message passing is ~1ms in
    // the worst reported cases; any delay silently turns into an error.
    // (openPanel only arrives from content scripts, which always have a tab.)
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      void browser.sidePanel
        .open({ tabId })
        .catch((err) => console.error('[0x Lens] sidePanel.open failed:', err));
    }

    // Hand the focused address to the panel via storage — robust across SW
    // restarts and panel (re)loads; the panel watches this key.
    void storage.setItem('session:lens:focus', message.address).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  return false;
}

export default defineBackground(() => {
  // Stable fallback: the toolbar icon always opens the panel.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[0x Lens] setPanelBehavior failed:', err));

  browser.runtime.onMessage.addListener(handleMessage);
});
