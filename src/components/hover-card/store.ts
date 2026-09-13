/**
 * Tiny external store bridging the (non-React) hover controller and the
 * (React) card layer. One card at a time, page lifetime.
 */

export interface CardTarget {
  identity: import('@/core/messaging/protocol').LensIdentity;
  /** Viewport rect of the hovered highlight box at trigger time. */
  anchorRect: DOMRect;
  /** True when the acquire animation was already played for this identity on
   *  this page — the card then opens instantly ("already scanned"语义). */
  fast: boolean;
}

type Listener = () => void;

class CardStore {
  private target: CardTarget | null = null;
  private readonly listeners = new Set<Listener>();

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): CardTarget | null => this.target;

  show(target: CardTarget): void {
    this.target = target;
    this.emit();
  }

  hide(): void {
    if (this.target) {
      this.target = null;
      this.emit();
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const cardStore = new CardStore();

/** Identities already resolved on this page — drives the fast re-hover path. */
export const resolvedAddresses = new Set<string>();

export const INTENT_MS = 200;
export const SCAN_MS = 350;
export const CLOSE_GRACE_MS = 160;
