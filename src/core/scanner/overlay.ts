import type { Address } from '../address';

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
 * Since Phase 3 the boxes are interactive (pointer-events: auto) — hovering
 * one triggers the acquire sequence; `.acquiring` + `.oxl-scanline` are the
 * glow/scan visuals driven by the hover controller.
 */

const HIGHLIGHT_CSS = `
  :host { all: initial; }
  .hl-layer { position: relative; }
  .hl {
    position: absolute;
    pointer-events: auto;
    cursor: pointer;
    border-radius: 3px;
    background: rgba(94, 234, 212, 0.06);
    box-shadow: inset 0 -1px 0 rgba(94, 234, 212, 0.4);
    transition: background 0.12s ease, box-shadow 0.12s ease;
  }
  .hl:hover {
    background: rgba(94, 234, 212, 0.12);
    box-shadow: inset 0 -1px 0 rgba(94, 234, 212, 0.65);
  }
  .hl.acquiring {
    background: rgba(94, 234, 212, 0.18);
    box-shadow: inset 0 -1px 0 rgba(94, 234, 212, 0.9), 0 0 12px rgba(94, 234, 212, 0.25);
  }
  .oxl-scanline {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    pointer-events: none;
    background: rgba(94, 234, 212, 0.95);
    box-shadow: 0 0 8px rgba(94, 234, 212, 0.9);
    animation: oxl-sweep 0.35s ease-in-out forwards;
  }
  @keyframes oxl-sweep {
    from { left: 0; }
    to { left: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .oxl-scanline { animation-duration: 0.01s; }
    .hl { transition: none; }
  }
`;

export class OverlayLayer {
  readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  /** Event-delegation surface for all highlight boxes (inside the shadow root,
   *  so listeners see the real targets, not the retargeted host). */
  private readonly layer: HTMLDivElement;

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
    this.layer = document.createElement('div');
    this.layer.className = 'hl-layer';
    this.root.append(style, this.layer);

    // documentElement (not body): avoids body-level transforms creating a
    // different containing block for our absolute coordinates.
    document.documentElement.append(this.host);
  }

  get eventSurface(): HTMLDivElement {
    return this.layer;
  }

  alloc(address: Address): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'hl';
    el.dataset.address = address;
    this.layer.append(el);
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

  /** Initial-scan stats, bridged through the DOM so main-world tooling
   *  (e2e, devtools console of the page) can read them. */
  reportStats(stats: { textNodes: number; matches: number; ms: number }): void {
    this.host.dataset.scanStats = JSON.stringify(stats);
  }
}
