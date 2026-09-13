import { LensScanner } from '@/core/scanner/scanner';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Top frame only in V1 (CLAUDE.md): embedded iframes (tweets, widgets)
    // get no scanner — per-frame double UI is worse than the missed coverage.
    if (window !== window.top) return;
    new LensScanner().start();
  },
});
