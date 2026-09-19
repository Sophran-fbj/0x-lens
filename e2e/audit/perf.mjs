/**
 * Nightly audit — performance & resources (offline).
 * Repeated-run measurements with median/range for scan scaling, match
 * scaling, cap behavior, churn stability, layout-shift churn and hover
 * re-hover overhead. Wall time includes idle-scheduling waits (documented).
 *   node e2e/audit/perf.mjs   (needs fixture server + built extension)
 */
import { launchExtension } from '../browser.mjs';
import { check, finish } from './helpers.mjs';

const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
const range = (arr) => `${Math.min(...arr)}–${Math.max(...arr)}`;

const ctx = await launchExtension({ viewport: { width: 1280, height: 900 } });
const perf = { env: {}, configs: [], churn: {}, hover: {} };

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  perf.env.ua = await page.evaluate(() => navigator.userAgent);
  perf.env.cores = await page.evaluate(() => navigator.hardwareConcurrency);
  perf.env.dpr = await page.evaluate(() => window.devicePixelRatio);

  const scanOnce = async (qs) => {
    const url = `http://localhost:5173/audit-perf.html${qs}`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
      () => Boolean(document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats),
      null, { timeout: 60000 },
    );
    // let the idle queue fully drain (timeout 500ms per idle callback)
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const host = document.querySelector('[data-0x-lens-overlay]');
      const stats = JSON.parse(host.dataset.scanStats);
      const measure = performance.getEntriesByName('oxl:initial-scan').pop();
      return {
        textNodes: stats.textNodes,
        matches: stats.matches,
        wallMs: stats.ms,
        mainMs: measure ? Math.round(measure.duration) : null,
        hlCount: host.shadowRoot.querySelectorAll('.hl').length,
        domNodes: document.getElementsByTagName('*').length,
      };
    });
  };

  const CONFIGS = [
    { name: '1k nodes / 10 matches', qs: '?nodes=1000&matches=10', expectMatches: 10 },
    { name: '5k nodes / 100 matches', qs: '?nodes=5000&matches=100', expectMatches: 100 },
    { name: '10k nodes / 500 matches', qs: '?nodes=10000&matches=500', expectMatches: 500 },
    { name: '10k nodes / 600 matches (cap)', qs: '?nodes=10000&matches=600', expectCap: 500 },
    { name: 'explorer table (1.8k nodes / ~150 matches)', qs: '?nodes=1000&matches=150&table=1' },
  ];

  for (const cfg of CONFIGS) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await scanOnce(cfg.qs));
    const walls = runs.map((r) => r.wallMs);
    const row = {
      name: cfg.name,
      runs: runs.length,
      textNodes: runs[0].textNodes,
      matches: runs[0].matches,
      wallMs: { median: median(walls), range: range(walls) },
      mainMs: { median: median(runs.map((r) => r.mainMs)) },
      hlCount: runs[0].hlCount,
      domNodes: runs[0].domNodes,
    };
    perf.configs.push(row);
    console.log(`[perf] ${cfg.name}: ${JSON.stringify(row)}`);
    const last = runs[runs.length - 1];
    if (cfg.expectCap) {
      check(`P-cap ${cfg.name}: highlights capped at 500`, last.hlCount <= 500,
        `hl=${last.hlCount}`);
    } else if (cfg.expectMatches) {
      check(`P ${cfg.name}: match count stable`, last.matches === cfg.expectMatches && last.hlCount === cfg.expectMatches,
        `matches=${last.matches} hl=${last.hlCount}`);
    }
  }

  // ---- churn scenarios (1k-node page): overlay + DOM must not grow --------
  await page.goto('http://localhost:5173/audit-perf.html?nodes=1000&matches=50', { waitUntil: 'load' });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats));
  await page.waitForTimeout(1200);
  const base = await page.evaluate(() => ({
    hl: document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
    dom: document.getElementsByTagName('*').length,
  }));

  // mutation burst
  await page.click('#burst');
  await page.waitForTimeout(1200);
  const afterBurst = await page.evaluate(() => ({
    hl: document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
    dom: document.getElementsByTagName('*').length,
  }));
  check('P-burst overlay count returns to baseline (no leak)',
    afterBurst.hl === base.hl, `hl ${base.hl} → ${afterBurst.hl}`);

  // virtual-list recycle ×10
  await page.click('#vlist'); // create 50 rows
  await page.waitForTimeout(900);
  for (let i = 0; i < 10; i++) {
    await page.click('#vlist');
    await page.waitForTimeout(450);
  }
  await page.waitForTimeout(900);
  const afterVlist = await page.evaluate(() => ({
    hl: document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
    dom: document.getElementsByTagName('*').length,
  }));
  check('P-vlist overlay count stable after 10 recycles (50 rows)',
    afterVlist.hl === base.hl + 50, `hl=${afterVlist.hl} (base+50=${base.hl + 50})`);

  // layout-shift churn
  await page.click('#shift10');
  await page.waitForTimeout(2500);
  const afterShift = await page.evaluate(() => ({
    hl: document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
    dom: document.getElementsByTagName('*').length,
  }));
  check('P-shift overlay count stable after 10 layout shifts',
    afterShift.hl === base.hl + 50, `hl=${afterShift.hl}`);
  perf.churn = { base, afterBurst, afterVlist, afterShift };

  // ---- hover overhead: cached re-hover vs first hover ----------------------
  // (identities cached in this page's session → no RPC on re-hover; the
  // timing difference isolates animation + card mount overhead)
  await page.goto('http://localhost:5173/audit-perf.html?nodes=1000&matches=10', { waitUntil: 'load' });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats));
  await page.waitForTimeout(800);
  const hoverOnce = async () => {
    const t0 = Date.now();
    const c = await page.evaluate(() => {
      const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
      const hl = root.querySelector('.hl[data-address]');
      const b = hl.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.move(8, 60);
    await page.waitForTimeout(300);
    await page.mouse.move(c.x, c.y, { steps: 3 });
    await page.waitForFunction(
      () => document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card'),
      null, { timeout: 15000 });
    const ms = Date.now() - t0;
    await page.mouse.move(8, 60);
    await page.waitForTimeout(400);
    return ms;
  };
  const first = await hoverOnce();
  const cached = [await hoverOnce(), await hoverOnce(), await hoverOnce()];
  perf.hover = { firstMs: first, cachedMedianMs: median(cached), cachedRange: range(cached) };
  console.log(`[perf] hover: first=${first}ms cached median=${perf.hover.cachedMedianMs}ms (${perf.hover.cachedRange})`);
  check('P-hover cached re-hover ≤ 2.5s (animation-dominated, cache path)',
    perf.hover.cachedMedianMs < 2500, `${perf.hover.cachedMedianMs}ms`);

  const fs = await import('node:fs');
  fs.writeFileSync('docs/nightly-audit/perf-runs.json', JSON.stringify(perf, null, 2));
  console.log('\nperf data → docs/nightly-audit/perf-runs.json');

  process.exitCode = (await finish('perf')) ? 0 : 1;
} finally {
  await ctx.close();
}
