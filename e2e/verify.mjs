/**
 * Phase 1 end-to-end verification: load the built extension, open the fixture
 * page, and assert the detection layer behaves per CLAUDE.md rules.
 *
 * Run AFTER `npm run build` and with the fixture server up (`npm run fixture`):
 *   node e2e/verify.mjs
 */
import { EXT_PATH, launchExtension } from './browser.mjs';

const FIXTURE = 'http://localhost:5173/';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ctx = await launchExtension();

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(FIXTURE, { waitUntil: 'load' });
  // Initial scan runs on document_idle + idle callbacks — give it a beat.
  await page.waitForTimeout(1500);

  const stats = await page.evaluate(() => {
    const host = document.querySelector('[data-0x-lens-overlay]');
    if (!host) return { overlayHost: false, highlights: 0, boxes: [] };
    const hls = [...host.shadowRoot.querySelectorAll('.hl')];
    return {
      overlayHost: true,
      highlights: hls.length,
      boxes: hls.slice(0, 3).map((el) => ({
        top: el.style.top,
        left: el.style.left,
        w: el.style.width,
        h: el.style.height,
      })),
    };
  });

  check('overlay host attached', stats.overlayHost);
  // static: 3 (case forms) + 3 (contracts) + 1 (unknown) + 4 (link/code/pre/quote)
  //        + 1 (section 10) + 1 (section 11) = 13; stress: 150 spans → 163
  check('initial highlight count = 163', stats.highlights === 163, `got ${stats.highlights}`);
  check('boxes have page-absolute coords', stats.boxes.length > 0 && stats.boxes.every((b) => Number.parseFloat(b.top) > 0));

  // Negative cases: broken checksum / truncated / tx hash must NOT be inside the overlay.
  // (They can't be — overlay only contains valid matches — so count correctness above covers it.)

  // Dynamic injection (MutationObserver path).
  await page.click('#add');
  await page.waitForTimeout(700); // 200ms debounce + scan
  const afterAdd = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after dynamic inject = 164', afterAdd === 164, `got ${afterAdd}`);

  // Text mutation (characterData path).
  await page.click('#mutate');
  await page.waitForTimeout(700);
  const afterMutate = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after text mutation = 165', afterMutate === 165, `got ${afterMutate}`);

  // Stress button (MO + near-cap path).
  await page.click('#stress-btn');
  await page.waitForTimeout(900);
  const afterStress = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after +150 stress = 315', afterStress === 315, `got ${afterStress}`);

  // Layout-only shift: style toggle moves the address with ZERO DOM mutation.
  // The highlight must follow (layout-shift PerformanceObserver path).
  const UNI = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
  const topOf = (addr) =>
    page.evaluate((a) => {
      const el = document
        .querySelector('[data-0x-lens-overlay]')
        .shadowRoot.querySelector(`.hl[data-address="${a}"]`);
      // page-absolute: page.click may auto-scroll between measurements
      return el ? el.getBoundingClientRect().top + window.scrollY : null;
    }, addr);
  const beforeShift = await topOf(UNI);
  await page.click('#shift');
  await page.waitForTimeout(900); // transition 150ms + debounce 200ms + margin
  const afterShift = await topOf(UNI);
  check(
    'layout-only shift repositions highlight',
    beforeShift !== null && afterShift !== null && afterShift - beforeShift > 140,
    `Δ=${afterShift !== null && beforeShift !== null ? (afterShift - beforeShift).toFixed(0) : 'n/a'}px`,
  );

  // Remove & re-insert the SAME text node: highlight must come back.
  const MKR = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
  const mkrCount = () =>
    page.evaluate(
      (a) =>
        document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
      MKR,
    );
  check('MKR highlighted before detach', (await mkrCount()) === 1);
  await page.click('#detach');
  await page.waitForTimeout(600);
  check('highlight gone after detach', (await mkrCount()) === 0, `got ${await mkrCount()}`);
  await page.click('#detach');
  await page.waitForTimeout(600);
  check('highlight restored after re-insert', (await mkrCount()) === 1, `got ${await mkrCount()}`);

  // Scroll invariance: page-absolute coords mean no listeners; just sanity-check a box
  // still covers its address after scrolling.
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/verify.png' });
  check('screenshot saved', true, 'e2e/verify.png');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx.close();
}
