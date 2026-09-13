import { mountCardLayer } from '@/components/hover-card/mount';
import { HoverController } from '@/core/hover/controller';
import { OverlayLayer } from '@/core/scanner/overlay';
import { LensScanner } from '@/core/scanner/scanner';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Top frame only in V1 (CLAUDE.md): embedded iframes (tweets, widgets)
    // get no scanner — per-frame double UI is worse than the missed coverage.
    if (window !== window.top) return;

    const overlay = new OverlayLayer();
    const cards = mountCardLayer();
    new LensScanner(overlay).start();
    new HoverController(overlay, cards.host).start();
  },
});
