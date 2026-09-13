import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // Stable fallback: the toolbar icon always opens the panel, independent of
  // the content-script gesture path below.
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[0x Lens] setPanelBehavior failed:', err));

  // ⚠️ Gesture rule (CLAUDE.md): when the 'lens/openPanel' handler lands in
  // Phase 4, sidePanel.open() must be the FIRST statement — no awaits, no
  // animation ticks in between. The user-gesture window through message
  // passing is ~1ms in the worst reported cases.
  //
  // Phase 2 adds: viem publicClient + the Promise.all → multicall pipeline,
  // storage.session cache and the 'lens/resolve' handler.
});
