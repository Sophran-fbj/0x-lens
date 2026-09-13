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
  private readonly nodeMatches = new Map<Text, MatchEntry[]>();
  private readonly processed = new WeakSet<Text>();
  private mo: MutationObserver | null = null;
  private pendingRoots: Node[] = [];
  private pendingTexts: Text[] = [];
  private flushTimer: number | null = null;
  private liveMatches = 0;
  private capLogged = false;
  private startedAt = 0;

  constructor(private readonly overlay: OverlayLayer) {}

  start(): void {
    if (this.mo) return; // idempotent
    this.startedAt = performance.now();
    performance.mark('oxl:scan-start');
    this.scheduleInitialScan();
    this.observe();
    window.addEventListener('resize', this.scheduleFlush);
    // Late font loading shifts text — recompute all rects once fonts settle.
    document.fonts?.ready.then(() => this.scheduleFlush());
    // Layout-only shifts (image load, accordions, class/style toggles)
    // produce NO DOM mutations — but they move our page-absolute boxes.
    // The browser's layout-shift entries are exactly the signal we need;
    // scroll is excluded by definition, and our own overlay boxes cause no
    // layout, so they never fire this. Safe only because repositioning
    // updates boxes in place (see positionEntry).
    try {
      new PerformanceObserver(() => this.scheduleFlush()).observe({
        type: 'layout-shift',
        buffered: false,
      });
    } catch {
      /* engine without layout-shift support — resize/fonts still cover most cases */
    }
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
      // Small stats surface for e2e/perf measurement, bridged through the
      // DOM (shared between isolated and main worlds; window is NOT).
      const stats = {
        textNodes: nodes.length,
        matches: this.liveMatches,
        ms: Math.round(performance.now() - this.startedAt),
      };
      this.overlay.reportStats(stats);
      if (import.meta.env.DEV) {
        console.info(
          `[0x Lens] initial scan: ${stats.textNodes} text nodes → ${stats.matches} matches in ${stats.ms}ms`,
        );
      }
      // Entries can carry zero boxes if text existed before first layout
      // (observed on SSR-heavy sites: matches found, rects empty). A delayed
      // re-flush repositions them once the page has actually painted.
      window.setTimeout(() => this.scheduleFlush(), 1200);
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
   *  node changed underneath us and the range is no longer valid.
   *  Existing boxes are UPDATED in place, never destroyed — repositioning
   *  runs on every layout shift, and replacing nodes would churn hover
   *  state (found by review round 2: the card stopped opening). */
  private positionEntry(entry: MatchEntry): void {
    let rects: DOMRect[];
    try {
      const range = document.createRange();
      range.setStart(entry.node, entry.start);
      range.setEnd(entry.node, entry.end);
      rects = [...range.getClientRects()].filter(
        (r) => r.width > 0 && r.height > 0, // display:none etc.
      );
    } catch {
      this.dropEntry(entry);
      return;
    }
    // Sync box count to the (possibly changed) rect count, then update.
    while (entry.els.length > rects.length) this.overlay.release(entry.els.pop()!);
    while (entry.els.length < rects.length) entry.els.push(this.overlay.alloc(entry.address));
    for (let i = 0; i < rects.length; i++) {
      this.overlay.place(entry.els[i]!, rects[i]!);
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
    // 1. Prune matches whose text node left the DOM (SPA re-renders). Also
    //    clear `processed` — virtual lists re-insert the SAME node later,
    //    and it must rescan then (found by review: 1 → 0 → 0 was permanent).
    for (const [node, entries] of this.nodeMatches) {
      if (!node.isConnected) {
        for (const e of entries) for (const el of e.els) this.overlay.release(el);
        this.liveMatches -= entries.length;
        this.nodeMatches.delete(node);
        this.processed.delete(node);
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
