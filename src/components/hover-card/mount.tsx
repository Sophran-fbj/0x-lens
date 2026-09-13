import { createRoot } from 'react-dom/client';
import cardCssText from './card.css?inline';
import { CardLayer } from './CardLayer';

/**
 * Card layer mount: host <div> on document.documentElement with its own open
 * shadow root — `all: initial` in card.css stops inherited page styles at the
 * boundary. The host carries only inline styles; React renders inside.
 */

export function mountCardLayer(): { host: HTMLDivElement; dispose: () => void } {
  const host = document.createElement('div');
  host.setAttribute('data-0x-lens-card', '');
  host.style.position = 'absolute';
  host.style.top = '0';
  host.style.left = '0';
  host.style.pointerEvents = 'none';
  host.style.zIndex = '2147483647';

  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = cardCssText;
  root.append(style);

  const container = document.createElement('div');
  root.append(container);

  document.documentElement.append(host);
  const reactRoot = createRoot(container);
  reactRoot.render(<CardLayer />);

  return {
    host,
    dispose() {
      reactRoot.unmount();
      host.remove();
    },
  };
}
