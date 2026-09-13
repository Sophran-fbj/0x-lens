import { parseAddress, type Address } from '../address';
import { OverlayLayer } from './overlay';
import { scanTextNode, walkTextNodes, type RawMatch } from './walker';

/**
 * LensScanner — detection orchestration.
 *
 * - Initial scan: TreeWalker over body, chunked on requestIdleCallback.
 * - Incremental: MutationObserver (childList + characterData), debounced and
 *   batched; only added subtrees and changed text nodes are (re)scanned.
 * - Dedup: a WeakSet of already-scanned text nodes; matches grouped per node.
 * - Hard cap of MAX_MATCHES live highlights (explorer tables must not explode).
 * - performance.mark/measure around the initial scan (dev log + resume data).
 *
 * Our overlay host lives on document.documentElement, outside the observed
 * body — our own DOM writes never re-trigger the observer.
 */

interface MatchEntry {
  address: Address;
  node: Text;
  start: number;
  end: number;
  els: HTMLDivElement[]; // one highlight box per client rect (wrapping = N)
}

const MAX_MATCHES = 500;
const MO_DEBOUNCE_MS = 200;
const IDLE_BUDGET_MS = 8; // scan work budget per idle tick

export class LensScanner {
  private readonly overlay = new OverlayLayer();
  private readonly nodeMatches = new Map<Text, MatchEntry[]>();
  private readonly processed = new WeakSet<Text>();
  private mo: MutationObserver | null = null;
  private pendingRoots: Node[] = [];
  private pendingTexts: Text[] = [];
  private flushTimer: number | null = null;
  private liveMatches = 0;
  private capLogged = false;
  private startedAt = 0;

  start(): void {
    if (this.mo) return; // idempotent
    this.startedAt = performance.now();
    performance.mark('oxl:scan-start');
    this.scheduleInitialScan();
    this.observe();
    window.addEventListener('resize', this.scheduleFlush);
    // Late font loading shifts text — recompute all rects once fonts settle.
    document.fonts?.ready.then(() => this.scheduleFlush());
  }

  // ---- initial scan -------------------------------------------------------

  private scheduleInitialScan(): void {
    const nodes: Text[] = [];
    for (const n of walkTextNodes(document.body)) nodes.push(n);
    let i = 0;
    const pump = (): void => {
      const deadline = performance.now() + IDLE_BUDGET_MS;
      while (i < nodes.length && performance.now() < deadline) {
        this.scanNode(nodes[i++]!);
      }
      if (i < nodes.length) {
        this.requestIdle(pump);
        return;
      }
      performance.mark('oxl:scan-end');
      performance.measure('oxl:initial-scan', 'oxl:scan-start', 'oxl:scan-end');
      if (import.meta.env.DEV) {
        const ms = (performance.now() - this.startedAt).toFixed(1);
        console.info(
          `[0x Lens] initial scan: ${nodes.length} text nodes → ${this.liveMatches} matches in ${ms}ms`,
        );
      }
    };
    this.requestIdle(pump);
  }

  private requestIdle(fn: () => void): void {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: 500 });
    } else {
      setTimeout(fn, 0);
    }
  }

  // ---- scanning -----------------------------------------------------------

  private scanNode(node: Text): void {
    if (this.processed.has(node) || !node.isConnected) return;
    this.processed.add(node);

    const valid: Array<RawMatch & { address: Address }> = [];
    for (const r of scanTextNode(node)) {
      const address = parseAddress(r.raw);
      if (address) valid.push({ ...r, address });
    }
    if (valid.length === 0) return;

    if (this.liveMatches >= MAX_MATCHES) {
      this.logCapOnce();
      return;
    }

    const entries: MatchEntry[] = [];
    for (const v of valid) {
      if (this.liveMatches >= MAX_MATCHES) {
        this.logCapOnce();
        break;
      }
      const entry: MatchEntry = {
        address: v.address,
        node,
        start: v.start,
        end: v.end,
        els: [],
      };
      this.positionEntry(entry);
      entries.push(entry);
      this.liveMatches++;
    }
    if (entries.length > 0) this.nodeMatches.set(node, entries);
  }

  private logCapOnce(): void {
    if (this.capLogged) return;
    this.capLogged = true;
    if (import.meta.env.DEV) {
      console.info(`[0x Lens] match cap (${MAX_MATCHES}) reached — further matches skipped`);
    }
  }

  /** (Re)compute the highlight boxes for one match. Drops it if the text
   *  node changed underneath us and the range is no longer valid. */
  private positionEntry(entry: MatchEntry): void {
    for (const el of entry.els) this.overlay.release(el);
    entry.els = [];

    let rects: DOMRectList;
    try {
      const range = document.createRange();
      range.setStart(entry.node, entry.start);
      range.setEnd(entry.node, entry.end);
      rects = range.getClientRects();
    } catch {
      this.dropEntry(entry);
      return;
    }
    for (const rect of rects) {
      if (rect.width === 0 || rect.height === 0) continue; // display:none etc.
      const el = this.overlay.alloc();
      this.overlay.place(el, rect);
      entry.els.push(el);
    }
  }

  private dropEntry(entry: MatchEntry): void {
    for (const el of entry.els) this.overlay.release(el);
    entry.els = [];
    const siblings = this.nodeMatches.get(entry.node);
    if (!siblings) return;
    const idx = siblings.indexOf(entry);
    if (idx !== -1) siblings.splice(idx, 1);
    if (siblings.length === 0) this.nodeMatches.delete(entry.node);
    this.liveMatches--;
  }

  // ---- incremental updates ------------------------------------------------

  private observe(): void {
    this.mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of r.addedNodes) this.pendingRoots.push(n);
        } else if (r.type === 'characterData') {
          this.pendingTexts.push(r.target as Text);
        }
      }
      if (records.length > 0) this.scheduleFlush();
    });
    this.mo.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  private readonly scheduleFlush = (): void => {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, MO_DEBOUNCE_MS);
  };

  private flush(): void {
    // 1. Prune matches whose text node left the DOM (SPA re-renders).
    for (const [node, entries] of this.nodeMatches) {
      if (!node.isConnected) {
        for (const e of entries) for (const el of e.els) this.overlay.release(el);
        this.liveMatches -= entries.length;
        this.nodeMatches.delete(node);
      }
    }

    // 2. Rescan text nodes whose content changed.
    const texts = this.pendingTexts;
    this.pendingTexts = [];
    for (const t of texts) this.invalidate(t);

    // 3. Scan added subtrees (WeakSet dedups overlap with previous scans).
    const roots = this.pendingRoots;
    this.pendingRoots = [];
    for (const root of roots) {
      if (!root.isConnected) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        this.scanNode(root as Text);
      } else {
        for (const n of walkTextNodes(root)) this.scanNode(n);
      }
    }

    // 4. Layout may have shifted anywhere — recompute all boxes.
    this.repositionAll();
  }

  private invalidate(node: Text): void {
    const entries = this.nodeMatches.get(node);
    if (entries) {
      for (const e of entries) for (const el of e.els) this.overlay.release(el);
      this.liveMatches -= entries.length;
      this.nodeMatches.delete(node);
    }
    this.processed.delete(node);
    this.scanNode(node);
  }

  private repositionAll(): void {
    for (const entries of this.nodeMatches.values()) {
      for (const e of [...entries]) this.positionEntry(e);
    }
  }
}
