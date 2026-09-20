/**
 * Nightly audit — geometry, scroll & layout (offline, real browser).
 * Verifies the core design assumption "page-absolute overlay → window scroll
 * needs no listeners" for normal flow, and probes fixed/sticky/nested-scroll
 * drift hypotheses (S-G10..G14 expected to FAIL until a fix lands).
 *   node e2e/audit/geometry.mjs   (needs fixture server + built extension)
 */
import { launchExtension } from '../browser.mjs';
import { check, finish, openAuditedPage, measureCoverage } from './helpers.mjs';

const URL = 'http://localhost:5173/audit.html';
const TOL = 1.5; // px — acceptable rect↔box rounding error

const ctx = await launchExtension({ viewport: { width: 1280, height: 900 } });

try {
  const page = await openAuditedPage(ctx, URL);
  const A = await page.evaluate(() => window.__auditAddrs);
  const click = (sel) => page.locator(sel).evaluate((b) => b.click());

  const cov = (identity, probeSel) => measureCoverage(page, identity, probeSel);
  const covered = (m) => m.boxes.length > 0 && m.maxDelta <= TOL;

  // G1 single line: box geometry == live Range rect within tolerance.
  check('G1 single-line box matches Range rect (±1.5px)',
    covered(await cov(A[16], '#g1-node')),
    `maxΔ=${(await cov(A[16], '#g1-node')).maxDelta?.toFixed(2)}px`);

  // G2 multi-line wrap: one identity → N boxes, each matching a live rect.
  {
    const m = await cov(A[20], '#g2-node');
    check('G2 wrapped address: N boxes == N rects, each within tolerance',
      m.boxes.length >= 2 && m.boxes.length === m.rects.length && m.maxDelta <= TOL,
      `boxes=${m.boxes.length} rects=${m.rects.length} maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px`);
  }

  // G3 transformed ancestor (static transform): box matches visual position.
  check('G3 transformed ancestor covered',
    covered(await cov(A[34], '#g3-node')),
    `maxΔ=${(await cov(A[34], '#g3-node')).maxDelta?.toFixed(2)}px`);

  // G4 CSS transition: after transitionend + debounce, final geometry correct.
  await click('#g4-btn');
  await page.waitForTimeout(1200); // 300ms transition + 300ms debounce + margin
  check('G4 transition final position covered',
    covered(await cov(A[23], '#g4-target')));

  // G5 keyframe animation: after animationend + debounce, geometry correct.
  await click('#g5-btn');
  await page.waitForTimeout(1400); // 600ms animation + debounce + margin
  check('G5 keyframe final position covered',
    covered(await cov(A[24], '#g5-target')));

  // G6 late font load (font swap → metrics change → reflow).
  await click('#g6-btn');
  await page.waitForTimeout(900);
  check('G6 late font load reposition covered',
    covered(await cov(A[26], '#g6-node')));

  // G7 image-triggered layout shift (no DOM/text mutation).
  await click('#g7-btn');
  await page.waitForTimeout(1400); // layout-shift observer + 300ms debounce
  check('G7 image layout shift reposition covered',
    covered(await cov(A[27], '#g7-node')));

  // G8 viewport resize.
  const g8Before = await cov(A[16], '#g1-node');
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(700); // resize listener + debounce
  const g8After = await cov(A[16], '#g1-node');
  check('G8 resize keeps boxes on the text', covered(g8After));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(700);
  void g8Before;

  // G9 devicePixelRatio / zoom emulation.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1.5, width: 1280, height: 900, mobile: false,
  });
  await page.waitForTimeout(700);
  const g9 = await cov(A[16], '#g1-node');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await page.waitForTimeout(400);
  check('G9 DPR 1.5 emulation keeps boxes on the text', covered(g9),
    `maxΔ=${g9.maxDelta === Infinity ? '∞' : g9.maxDelta.toFixed(2)}px`);

  // G10 sticky element under window scroll: scroll past its natural position
  // so it is genuinely stuck at viewport top, then scroll 600 more — the
  // stuck element visually stays put while the document moves underneath.
  // (Hypothesis: sticky displacement fires layout-shift entries, which the
  // scanner's PerformanceObserver converts into a debounced reposition.)
  await page.evaluate(() => {
    document.getElementById('g10-sticky-head').scrollIntoView({ block: 'start' });
  });
  await page.evaluate(() => window.scrollBy(0, 600));
  await page.waitForTimeout(1500); // well past the 300ms reposition debounce
  {
    const m = await cov(A[28], '#g10-node');
    check('G10 sticky address stays covered while stuck', covered(m),
      `maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px boxes=${m.boxes.length}`);
  }

  // G11 fixed element under window scroll. All debounced repositions are
  // allowed to settle at scrollY=0 FIRST, so the measurement isolates the
  // effect of scrolling alone.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, 800));
  await page.waitForTimeout(800); // any layout-shift-triggered pass would have run by now
  {
    const m = await cov(A[29], '#g11-node');
    check('G11 fixed address stays covered under window scroll', covered(m),
      `maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px boxes=${m.boxes.length}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  // G12 single nested overflow:auto container scrolled.
  await click('#g12-btn'); // scrolls the inner container to the identity row
  await page.waitForTimeout(500);
  {
    const m = await cov(A[30], '#g12-scroller');
    check('G12 nested-scroll address stays covered after inner scroll', covered(m),
      `maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px boxes=${m.boxes.length}`);
  }

  // G13 multi-level nested scrollers.
  await click('#g13-btn');
  await page.waitForTimeout(500);
  {
    const m = await cov(A[31], '#g13-inner');
    check('G13 doubly-nested scroll address stays covered', covered(m),
      `maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px boxes=${m.boxes.length}`);
  }

  // G14 horizontal scroll container.
  await click('#g14-btn');
  await page.waitForTimeout(500);
  {
    const m = await cov(A[32], '#g14-hscroll');
    check('G14 horizontally-scrolled address stays covered', covered(m),
      `maxΔ=${m.maxDelta === Infinity ? '∞' : m.maxDelta.toFixed(2)}px boxes=${m.boxes.length}`);
  }
  await page.evaluate(() => { document.getElementById('g14-hscroll').scrollLeft = 0; });

  // G15 display:none collapse and return.
  await click('#g15-btn'); // show
  await page.waitForTimeout(700);
  const g15shown = await cov(A[22], '#g15-collapse');
  await click('#g15-btn'); // hide
  await page.waitForTimeout(700);
  const g15hidden = await page.evaluate((a) => {
    const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
    return [...root.querySelectorAll(`.hl[data-address="${a}"]`)]
      .filter((el) => el.getBoundingClientRect().width > 0).length;
  }, A[22]);
  await click('#g15-btn'); // show again
  await page.waitForTimeout(700);
  const g15again = await cov(A[22], '#g15-collapse');
  check('G15 display:none → boxes drop; visible → boxes return',
    g15shown.boxes.length === 1 && g15hidden === 0 && g15again.boxes.length === 1,
    `shown=${g15shown.boxes.length} hidden=${g15hidden} again=${g15again.boxes.length}`);

  // G16 THE design assumption: window scroll needs no listeners.
  await page.evaluate(() => document.getElementById('g1-node').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  check('G16 window scroll: page-absolute overlay needs no reposition',
    covered(await cov(A[16], '#g1-node')),
    `maxΔ=${(await cov(A[16], '#g1-node')).maxDelta?.toFixed(2)}px`);

  process.exitCode = (await finish('geometry')) ? 0 : 1;
} finally {
  await ctx.close();
}
