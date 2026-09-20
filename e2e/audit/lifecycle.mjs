/**
 * Nightly audit — SPA & DOM lifecycle (offline).
 * Hypotheses S-L1..S-L14: mutation-driven updates never duplicate highlights,
 * never leak boxes, rescan moved/reused/detached nodes, and keep the
 * observer loop-free.
 *   node e2e/audit/lifecycle.mjs   (needs fixture server + built extension)
 */
import { launchExtension } from '../browser.mjs';
import { check, finish, openAuditedPage, countHl } from './helpers.mjs';

const URL = 'http://localhost:5173/audit.html';
const ctx = await launchExtension();

try {
  const page = await openAuditedPage(ctx, URL);
  const A = await page.evaluate(() => window.__auditAddrs);
  const click = (sel) => page.locator(sel).evaluate((b) => b.click());
  const settle = (ms = 700) => page.waitForTimeout(ms);

  const overlayChildCount = () =>
    page.evaluate(
      () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
    );

  // baseline for leak comparisons
  const baselineChildren = await overlayChildCount();

  // L1 characterData burst: 50 rapid text writes settle on one identity.
  await click('#l1-burst-char');
  await settle();
  check('L1 charData burst settles on exactly one highlight',
    (await countHl(page, A[0])) === 1, `got ${await countHl(page, A[0])}`);

  // L2 childList burst: 50 added, 45 removed synchronously → 5 survivors.
  await click('#l2-burst-child');
  await settle();
  check('L2 childList burst leaves exactly 5 highlights',
    (await countHl(page, A[22])) === 5, `got ${await countHl(page, A[22])}`);

  // L3 add/remove cycles: 100 synchronous append+remove rounds ×3 → no leak.
  for (let i = 0; i < 3; i++) { await click('#l3-cycles'); await settle(500); }
  const afterCycles = await overlayChildCount();
  check('L3 add/remove cycles leak nothing',
    (await countHl(page, A[40])) === 0 && afterCycles === baselineChildren + 6,
    `overlay children ${baselineChildren} → ${afterCycles} (expect +6: L1 + L2×5)`);

  // L4 node moved between two parents twice: exactly one highlight, follows.
  await click('#l4-move'); await settle(600);
  const firstCount = await countHl(page, A[41]);
  await click('#l4-move'); await settle(600);
  check('L4 node moved between parents keeps exactly one highlight',
    firstCount === 1 && (await countHl(page, A[41])) === 1,
    `counts ${firstCount} → ${await countHl(page, A[41])}`);

  // L5 virtual-list recycling: same 10 text nodes re-texted to new identities.
  await click('#l5-vlist'); await settle(600); // create rows (10 × A25)
  check('L5a initial rows: 10 × A25', (await countHl(page, A[25])) === 10);
  await click('#l5-vlist'); await settle(600); // recycle → new identities
  const rowCoverage = await page.evaluate(() => {
    const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
    const boxes = [...root.querySelectorAll('.hl')];
    const rows = [...document.querySelectorAll('#l5-root p')];
    return rows.map((row) => {
      const rr = row.getBoundingClientRect();
      const covering = boxes.filter((b) => {
        const br = b.getBoundingClientRect();
        return br.left + br.width / 2 >= rr.left && br.left + br.width / 2 <= rr.right &&
          br.top + br.height / 2 >= rr.top && br.top + br.height / 2 <= rr.bottom;
      });
      return { identity: covering[0]?.dataset.address ?? covering[0]?.dataset.name ?? null, n: covering.length };
    });
  });
  const a25After = await countHl(page, A[25]);
  const rowsWellCovered = rowCoverage.filter((r) => r.n === 1).length;
  check('L5 recycled rows: each row exactly one box, old identity released',
    rowsWellCovered === 10 && a25After === 0,
    `covered=${rowsWellCovered}/10 A25=${a25After}`);

  // L6 react-style hydration (identical text node swap): no duplicate.
  await click('#l6-hydration'); await settle();
  check('L6 react-style hydration → exactly one highlight',
    (await countHl(page, A[38])) === 1, `got ${await countHl(page, A[38])}`);

  // L7 vue-style re-create (subtree replaced): exactly one.
  await click('#l7-recreate'); await settle();
  check('L7 vue-style re-create → exactly one highlight',
    (await countHl(page, A[42])) === 1, `got ${await countHl(page, A[42])}`);

  // L8 history.pushState then inject: scanned.
  await click('#l8-pushstate'); await settle();
  check('L8 pushState + inject → highlighted', (await countHl(page, A[39])) === 1,
    `got ${await countHl(page, A[39])}`);

  // L9 accordion open/close cycles: box appears over the accordion
  // paragraph and fully collapses back (rect-scoped: recycled L5 rows may
  // legally carry the same identity elsewhere on the page).
  const accordionCoverage = () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
      const rr = document.querySelector('#g9-accordion-body p').getBoundingClientRect();
      const covering = [...root.querySelectorAll('.hl')].filter((b) => {
        const br = b.getBoundingClientRect();
        return br.left + br.width / 2 >= rr.left && br.left + br.width / 2 <= rr.right &&
          br.top + br.height / 2 >= rr.top && br.top + br.height / 2 <= rr.bottom;
      });
      return covering.length;
    });
  await click('#l9-btn'); await settle(700);
  const openCount = await accordionCoverage();
  await click('#l9-btn'); await settle(700);
  const closedCount = await accordionCoverage();
  check('L9 accordion open shows 1, close releases it',
    openCount === 1 && closedCount === 0, `open=${openCount} closed=${closedCount}`);

  // L12 detached-subtree identity swap: old released, new scanned, no dup.
  // (A35 also appears in a recycled L5 row — assert via the l12 node's own
  // box coverage, not the page-wide count.)
  const l12Coverage = () =>
    page.evaluate(() => {
      const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
      const row = document.getElementById('l12-node').getBoundingClientRect();
      const covering = [...root.querySelectorAll('.hl')].filter((b) => {
        const br = b.getBoundingClientRect();
        return br.left + br.width / 2 >= row.left && br.left + br.width / 2 <= row.right &&
          br.top + br.height / 2 >= row.top && br.top + br.height / 2 <= row.bottom;
      });
      return { n: covering.length, id: covering[0]?.dataset.address ?? null };
    });
  await click('#l12-detached'); await settle(800);
  const swapFwd = await l12Coverage();
  await click('#l12-detached'); await settle(800);
  const swapBack = await l12Coverage();
  check('L12 detached mutation swaps identity exactly once each way',
    swapFwd.n === 1 && swapFwd.id === A[29] && swapBack.n === 1 && swapBack.id === A[35],
    `fwd=${JSON.stringify(swapFwd)} back=${JSON.stringify(swapBack)}`);

  // L13 node into shadow DOM and back.
  await click('#l13-shadowbtn'); await settle(700);
  const inShadow = await countHl(page, A[12]);
  await click('#l13-shadowbtn'); await settle(700);
  check('L13 shadow move prunes, return re-highlights',
    inShadow === 0 && (await countHl(page, A[12])) === 1,
    `inShadow=${inShadow} back=${await countHl(page, A[12])}`);

  // L14 href replaced: highlight identity follows the new href.
  const d15Before = { a13: await countHl(page, A[13]), a14: await countHl(page, A[14]) };
  await click('#d15-btn'); await settle(800);
  const d15After = { a13: await countHl(page, A[13]), a14: await countHl(page, A[14]) };
  check('L14 href replacement swaps highlight identity',
    d15Before.a13 === 1 && d15Before.a14 === 0 &&
    d15After.a13 === 0 && d15After.a14 === 1,
    `before A13=${d15Before.a13}/A14=${d15Before.a14} after A13=${d15After.a13}/A14=${d15After.a14}`);

  // L15 observer self-loop proxy: after everything settles, the extension
  // must not keep mutating the page. Watch body + documentElement for 1.2s.
  const mutationCounts = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let bodyRecords = 0;
        let htmlChildren = 0;
        const mo = new MutationObserver((rs) => { bodyRecords += rs.length; });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
        const mo2 = new MutationObserver((rs) => { htmlChildren += rs.length; });
        mo2.observe(document.documentElement, { childList: true });
        setTimeout(() => { mo.disconnect(); mo2.disconnect(); resolve({ bodyRecords, htmlChildren }); }, 1200);
      }),
  );
  check('L15 no extension-induced mutations after settle (no observer loop)',
    mutationCounts.bodyRecords === 0 && mutationCounts.htmlChildren === 0,
    JSON.stringify(mutationCounts));

  // L16 navigation: old overlay must not survive into the next document;
  // the new document gets exactly one fresh overlay.
  await page.goto('http://localhost:5173/article.html', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  const navState = await page.evaluate(() => ({
    hosts: document.querySelectorAll('[data-0x-lens-overlay]').length,
    stats: Boolean(document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats),
  }));
  check('L16 after navigation: exactly one fresh overlay host',
    navState.hosts === 1 && navState.stats, JSON.stringify(navState));

  // L17 bfcache-style back/forward: restored document still has its overlay
  // and the scanner still reacts to new content.
  await page.goBack(); // back to audit.html
  await page.waitForTimeout(900);
  await click('#l8-pushstate'); await settle(700); // scanner alive after restore?
  const bfcacheHosts = await page.evaluate(
    () => document.querySelectorAll('[data-0x-lens-overlay]').length,
  );
  const bfcacheAlive = await countHl(page, A[39]) >= 1;
  check('L17 back-navigation: single overlay, scanner still live',
    bfcacheHosts === 1 && bfcacheAlive,
    `hosts=${bfcacheHosts} reactive=${bfcacheAlive}`);

  process.exitCode = (await finish('lifecycle')) ? 0 : 1;
} finally {
  await ctx.close();
}
