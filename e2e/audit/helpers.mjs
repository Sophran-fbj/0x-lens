/** Shared helpers for the nightly-audit e2e suites. */

export const results = [];
export function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

export function finish(suiteName) {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[${suiteName}] ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}

/** Open a page and wait until the extension's initial scan has settled. */
export async function openAuditedPage(ctx, url) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const host = document.querySelector('[data-0x-lens-overlay]');
    return Boolean(host?.dataset.scanStats);
  });
  return page;
}

/** Count .hl boxes carrying a given address or ENS name (page context).
 *  Deliberately matches BOTH dataset slots: 0x-prefixed ENS labels are legal,
 *  so the kind must never be inferred from the string. */
export async function countHl(page, identity) {
  return page.evaluate((id) => {
    const root = document.querySelector('[data-0x-lens-overlay]')?.shadowRoot;
    if (!root) return 0;
    return root.querySelectorAll(`.hl[data-address="${id}"], .hl[data-name="${id}"]`).length;
  }, identity);
}

/**
 * Compare the highlight boxes of one identity against the LIVE client rects
 * of its underlying text (recomputed from the DOM right now).
 * Returns { boxes, rects, maxDelta } with viewport-relative coordinates.
 */
/**
 * Compare the highlight boxes of one identity against the LIVE client rects
 * of the identity SUBSTRING inside the probe element (recomputed now).
 * Returns { boxes, rects, maxDelta } with viewport-relative coordinates.
 * maxDelta = worst nearest-rect distance (or size mismatch) in px; a box
 * count mismatch leaves unmatched entries behind and yields Infinity.
 */
export async function measureCoverage(page, identity, textProbeSelector) {
  return page.evaluate(
    ({ id, sel }) => {
      const root = document.querySelector('[data-0x-lens-overlay]')?.shadowRoot;
      const probe = document.querySelector(sel);
      const hlSel = `.hl[data-address="${id}"], .hl[data-name="${id}"]`;
      const boxes = [...root.querySelectorAll(hlSel)].map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, width: r.width, height: r.height };
      });
      if (!probe) return { boxes, rects: [], maxDelta: NaN };
      const rects = [];
      const needle = id.toLowerCase();
      const walker = document.createTreeWalker(probe, NodeFilter.SHOW_TEXT);
      let n = walker.nextNode();
      while (n) {
        const v = n.nodeValue ?? '';
        const idx = v.toLowerCase().indexOf(needle);
        if (idx >= 0) {
          const range = document.createRange();
          range.setStart(n, idx);
          range.setEnd(n, idx + id.length);
          for (const r of range.getClientRects()) {
            if (r.width > 0 && r.height > 0) {
              rects.push({ top: r.top, left: r.left, width: r.width, height: r.height });
            }
          }
        }
        n = walker.nextNode();
      }
      // Greedy nearest matching on (top,left); drift shows up as maxDelta.
      let maxDelta = 0;
      const pool = [...rects];
      for (const b of boxes) {
        let best = -1;
        let bestD = Infinity;
        pool.forEach((r, i) => {
          const d = Math.hypot(r.top - b.top, r.left - b.left);
          if (d < bestD) { bestD = d; best = i; }
        });
        if (best === -1) { maxDelta = Infinity; break; }
        const r = pool.splice(best, 1)[0];
        maxDelta = Math.max(maxDelta, bestD, Math.abs(r.width - b.width), Math.abs(r.height - b.height));
      }
      if (pool.length > 0) maxDelta = Infinity; // text rects without any box
      return { boxes, rects, maxDelta };
    },
    { id: identity, sel: textProbeSelector },
  );
}
