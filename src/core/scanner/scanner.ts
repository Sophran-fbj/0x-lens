import {
  parseAddress,
  parseEnsName,
  parseTruncatedCandidate,
  recoverFromHref,
  type Address,
} from '../address';
import { OverlayLayer } from './overlay';
import { scanTextNode, walkTextNodes, type CandidateKind } from './walker';

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
  /** Checksummed address, or lowercase ENS name — the identity to resolve. */
  identity: string;
  /** 'truncated' candidates are resolved to addresses at scan time. */
  kind: Exclude<CandidateKind, 'truncated'>;
  node: Text;
  start: number;
  end: number;
  els: HTMLDivElement[]; // one highlight box per client rect (wrapping = N)
}

const MAX_MATCHES = 500;
const MO_DEBOUNCE_MS = 200;
const REPOSITION_DEBOUNCE_MS = 300;
const IDLE_BUDGET_MS = 8; // scan work budget per idle tick

export class LensScanner {
  private readonly nodeMatches = new Map<Text, MatchEntry[]>();
  private readonly processed = new WeakSet<Text>();
  private mo: MutationObserver | null = null;
  private pendingRoots: Node[] = [];
  private pendingTexts: Text[] = [];
  private pendingHrefs: Element[] = [];
  private flushTimer: number | null = null;
  private repositionTimer: number | null = null;
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

  /** Scope test. NOT isConnected: a node moved into a same-document shadow
   *  tree is still "connected", but our body-rooted observer cannot see
   *  inside shadow trees — anything body.contains() doesn't reach is out of
   *  scope and must not be scanned, tracked, or kept. */
  private inScope(node: Node): boolean {
    return document.body.contains(node);
  }

  private scanNode(node: Text): void {
    if (this.processed.has(node) || !this.inScope(node)) return;
    this.processed.add(node);

    const valid: Array<{
      identity: string;
      kind: Exclude<CandidateKind, 'truncated'>;
      start: number;
      end: number;
    }> = [];
    for (const c of scanTextNode(node)) {
      if (c.kind === 'address') {
        const address = parseAddress(c.raw);
        if (address) valid.push({ identity: address, kind: 'address', start: c.start, end: c.end });
      } else if (c.kind === 'truncated') {
        // The full address is not in the text — recover it from the nearest
        // ancestor link's href (prefix/suffix must match the visible text).
        const cand = parseTruncatedCandidate(c.raw);
        const href = node.parentElement?.closest('a')?.getAttribute('href') ?? null;
        const address = cand ? recoverFromHref(href, cand) : null;
        if (address) valid.push({ identity: address, kind: 'address', start: c.start, end: c.end });
      } else {
        const name = parseEnsName(c.raw);
        if (name) valid.push({ identity: name, kind: 'name', start: c.start, end: c.end });
      }
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
        identity: v.identity,
        kind: v.kind,
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
    while (entry.els.length < rects.length) {
      entry.els.push(this.overlay.alloc(entry.identity, entry.kind));
    }
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
          // Subtrees leaving the DOM may come back (virtual lists, cached
          // views) — possibly MUTATED while detached, which our body-rooted
          // observer cannot see. Forget everything under them now.
          for (const n of r.removedNodes) this.clearProcessedUnder(n);
          for (const n of r.addedNodes) this.pendingRoots.push(n);
        } else if (r.type === 'characterData') {
          this.pendingTexts.push(r.target as Text);
        } else if (r.type === 'attributes') {
          if (r.attributeName === 'href') {
            // A link gained/changed its target: truncated text underneath
            // must re-validate against the new href.
            this.pendingHrefs.push(r.target as Element);
          } else {
            // class/style changes can move text (incl. via transform) with
            // no childList/characterData mutation — geometry only.
            this.scheduleReposition();
          }
        }
      }
      if (records.length > 0) this.scheduleFlush();
    });
    this.mo.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['href', 'class', 'style'],
    });

    // CSS transitions/animations (transform slides, keyframe accordions)
    // produce no attribute mutations at all — but their events do. The
    // *end/cancel* events matter most: a debounced reposition triggered by
    // the start event lands mid-animation for anything longer than the
    // debounce; only the completion event guarantees the final geometry.
    for (const ev of [
      'transitionrun',
      'transitionend',
      'transitioncancel',
      'animationstart',
      'animationend',
      'animationcancel',
    ]) {
      window.addEventListener(ev, this.scheduleReposition, { capture: true, passive: true });
    }
  }

  private clearProcessedUnder(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      this.processed.delete(root as Text);
      return;
    }
    for (const n of walkTextNodes(root)) this.processed.delete(n);
  }

  /** Light path: geometry only (transform/class/style motion). Deliberately
   *  separate from the full flush — animating pages fire this constantly. */
  private readonly scheduleReposition = (): void => {
    if (this.repositionTimer !== null) return;
    this.repositionTimer = window.setTimeout(() => {
      this.repositionTimer = null;
      this.repositionAll();
    }, REPOSITION_DEBOUNCE_MS);
  };

  private readonly scheduleFlush = (): void => {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, MO_DEBOUNCE_MS);
  };

  private flush(): void {
    // 1. Prune matches whose text node left the scan scope — detached OR
    //    moved into a shadow tree (still "connected" but invisible to our
    //    body observer). Also clear `processed`: virtual lists re-insert the
    //    SAME node later, and it must rescan then.
    for (const [node, entries] of this.nodeMatches) {
      if (!this.inScope(node)) {
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

    // 2b. Links whose href appeared/changed: re-validate their text.
    const hrefs = this.pendingHrefs;
    this.pendingHrefs = [];
    for (const a of hrefs) {
      if (!this.inScope(a)) continue;
      for (const n of walkTextNodes(a)) this.invalidate(n);
    }

    // 3. Scan added subtrees. invalidate (not bare scanNode): a subtree can
    //    be MOVED while staying connected — the prune sweep above won't have
    //    touched it, so its old entries must be released here or the old
    //    highlight boxes leak (duplicate boxes + liveMatches double-count).
    const roots = this.pendingRoots;
    this.pendingRoots = [];
    for (const root of roots) {
      if (!this.inScope(root)) continue;
      if (root.nodeType === Node.TEXT_NODE) {
        this.invalidate(root as Text);
      } else {
        for (const n of walkTextNodes(root)) this.invalidate(n);
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
