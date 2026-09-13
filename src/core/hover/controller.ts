import { openLens } from '@/core/messaging/client';
import type { LensIdentity } from '@/core/messaging/protocol';
import { identityKey } from '@/core/messaging/protocol';
import { cardStore, CLOSE_GRACE_MS, INTENT_MS, resolvedAddresses, SCAN_MS } from '@/components/hover-card/store';
import type { OverlayLayer } from '../scanner/overlay';

/**
 * HoverController — the acquire sequence orchestrator (non-React side).
 *
 *   hover 200ms (intent) → address glows + scan line sweeps (~350ms ≈ RPC
 *   latency — the animation IS the loading state) → card spring-opens
 *
 * Already-scanned addresses skip the ceremony and open instantly. Any scroll
 * cancels everything. Leaving the address/card gives a short grace period
 * for the mouse to travel between them.
 */

export class HoverController {
  private intentTimer: number | null = null;
  private scanTimer: number | null = null;
  private closeTimer: number | null = null;
  private scanHl: HTMLDivElement | null = null;
  private activeHl: HTMLDivElement | null = null;
  private readonly reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private readonly overlay: OverlayLayer,
    private readonly cardHost: HTMLDivElement,
  ) {}

  start(): void {
    this.overlay.eventSurface.addEventListener('mouseover', this.onOver);
    this.overlay.eventSurface.addEventListener('mouseout', this.onOut);
    this.overlay.eventSurface.addEventListener('click', this.onClick);
    this.cardHost.addEventListener('mouseover', this.cancelHide);
    this.cardHost.addEventListener('mouseout', this.scheduleHide);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
  }

  private readonly onOver = (e: MouseEvent): void => {
    const hl = closestHl(e.target);
    if (!hl || !(hl.dataset.address ?? hl.dataset.name)) return;
    this.cancelHide();
    if (this.activeHl === hl) return; // card already up for this box
    this.clearIntent();
    this.cancelScan();
    this.hideNow();
    this.intentTimer = window.setTimeout(() => this.trigger(hl), this.reduced ? 0 : INTENT_MS);
  };

  private readonly onOut = (e: MouseEvent): void => {
    if (!closestHl(e.target)) return;
    this.clearIntent();
    this.cancelScan();
    this.scheduleHide();
  };

  private readonly onScroll = (): void => {
    this.clearIntent();
    this.cancelScan();
    this.hideNow();
  };

  /** Clicking a highlighted identity opens the side panel focused on it.
   *  GESTURE RULE: the message goes out as the first statement. */
  private readonly onClick = (e: MouseEvent): void => {
    const identity = closestHl(e.target) && identityFrom(closestHl(e.target)!);
    if (!identity) return;
    openLens(identity);
    this.hideNow();
  };

  private readonly scheduleHide = (): void => {
    if (this.closeTimer !== null) return;
    this.closeTimer = window.setTimeout(() => {
      this.closeTimer = null;
      this.hideNow();
    }, CLOSE_GRACE_MS);
  };

  private readonly cancelHide = (): void => {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  };

  private trigger(hl: HTMLDivElement): void {
    const identity = identityFrom(hl);
    if (!identity) return;
    const anchorRect = hl.getBoundingClientRect();
    this.activeHl = hl;
    const key = identityKey(identity);

    const show = (): void => {
      this.cleanupScan();
      cardStore.show({ identity, anchorRect, fast: resolvedAddresses.has(key) });
    };

    if (this.reduced || resolvedAddresses.has(key)) {
      show();
      return;
    }
    // Acquire: glow + scan line, timed to read as "querying the chain".
    hl.classList.add('acquiring');
    const scan = document.createElement('div');
    scan.className = 'oxl-scanline';
    hl.append(scan);
    this.scanHl = hl;
    this.scanTimer = window.setTimeout(show, SCAN_MS);
  }

  private clearIntent(): void {
    if (this.intentTimer !== null) {
      clearTimeout(this.intentTimer);
      this.intentTimer = null;
    }
  }

  private cancelScan(): void {
    if (this.scanTimer !== null) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.cleanupScan();
  }

  private cleanupScan(): void {
    this.scanHl?.classList.remove('acquiring');
    this.scanHl?.querySelector('.oxl-scanline')?.remove();
    this.scanHl = null;
  }

  private hideNow(): void {
    this.activeHl = null;
    cardStore.hide();
  }
}

function closestHl(target: EventTarget | null): HTMLDivElement | null {
  return (target as Element | null)?.closest?.('.hl') as HTMLDivElement | null;
}

/** Highlight boxes carry the scanner's typed knowledge: dataset.address for
 *  addresses, dataset.name for ENS names (labels may start with 0x — never
 *  infer the kind from the string). */
function identityFrom(hl: HTMLDivElement): LensIdentity | null {
  if (hl.dataset.address) return { kind: 'address', address: hl.dataset.address as `0x${string}` };
  if (hl.dataset.name) return { kind: 'name', name: hl.dataset.name };
  return null;
}
