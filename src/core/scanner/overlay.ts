/**
 * Zero-mutation highlight layer.
 *
 * Highlights are absolutely-positioned boxes computed from
 * Range.getClientRects(), rendered inside a shadow root attached to a host
 * <div> on document.documentElement. The host page's DOM is never modified —
 * React/Vue/Svelte reconciliation can never see us.
 *
 * Coordinates are page-absolute (viewport rect + scroll offsets), so scrolling
 * needs no listeners; only reflows (fonts, images, DOM changes) require
 * repositioning, handled by the scanner's MutationObserver/resize hooks.
 *
 * Phase 1 styles are a placeholder tint; the real "acquire" look (scan line,
 * glow) lands in Phase 3 with the design tokens.
 */

// Placeholder highlight look — swapped for the Phase 3 design language.
const HIGHLIGHT_CSS = `
  :host { all: initial; }
  .hl {
    position: absolute;
    pointer-events: none;
    border-radius: 3px;
    background: rgba(94, 234, 212, 0.07);
    box-shadow: inset 0 -1px 0 rgba(94, 234, 212, 0.5);
  }
`;

export class OverlayLayer {
  readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;

  constructor() {
    this.host = document.createElement('div');
    this.host.setAttribute('data-0x-lens-overlay', '');
    // Host carries inline styles only; everything else lives in the shadow root.
    this.host.style.position = 'absolute';
    this.host.style.top = '0';
    this.host.style.left = '0';
    this.host.style.pointerEvents = 'none';
    this.host.style.zIndex = '2147483647';

    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HIGHLIGHT_CSS;
    this.root.append(style);

    // documentElement (not body): avoids body-level transforms creating a
    // different containing block for our absolute coordinates.
    document.documentElement.append(this.host);
  }

  alloc(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'hl';
    this.root.append(el);
    return el;
  }

  release(el: HTMLDivElement): void {
    el.remove();
  }

  /** Position a highlight box from a viewport-relative rect. */
  place(el: HTMLDivElement, rect: DOMRect): void {
    el.style.top = `${rect.top + window.scrollY}px`;
    el.style.left = `${rect.left + window.scrollX}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }
}
