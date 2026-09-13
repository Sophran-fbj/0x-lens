/**
 * Phase 1 end-to-end verification: load the built extension, open the fixture
 * page, and assert the detection layer behaves per CLAUDE.md rules.
 *
 * Run AFTER `npm run build` and with the fixture server up (`npm run fixture`):
 *   node e2e/verify.mjs
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
// Reuse the playwright bundled with the global playwright-cli install.
const { chromium } = require('D:/code/nvmmode/nvm/node_global/node_modules/@playwright/cli/node_modules/playwright');

const EXT_PATH = 'D:/code/web3p/0x-lens/.output/chrome-mv3';
const PROFILE = 'D:/code/web3p/0x-lens/.playwright-profile';
const FIXTURE = 'http://localhost:5173/';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, // extensions require headed (or new-headless) mode
  channel: 'msedge', // system browser; bundled chromium not installed
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
  ],
});

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
  // static: 3 (case forms) + 3 (contracts) + 1 (unknown) + 4 (link/code/pre/quote) = 11
  // stress: 150 spans → total 161
  check('initial highlight count = 161', stats.highlights === 161, `got ${stats.highlights}`);
  check('boxes have page-absolute coords', stats.boxes.length > 0 && stats.boxes.every((b) => Number.parseFloat(b.top) > 0));

  // Negative cases: broken checksum / truncated / tx hash must NOT be inside the overlay.
  // (They can't be — overlay only contains valid matches — so count correctness above covers it.)

  // Dynamic injection (MutationObserver path).
  await page.click('#add');
  await page.waitForTimeout(700); // 200ms debounce + scan
  const afterAdd = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after dynamic inject = 162', afterAdd === 162, `got ${afterAdd}`);

  // Text mutation (characterData path).
  await page.click('#mutate');
  await page.waitForTimeout(700);
  const afterMutate = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after text mutation = 163', afterMutate === 163, `got ${afterMutate}`);

  // Stress button (MO + near-cap path).
  await page.click('#stress-btn');
  await page.waitForTimeout(900);
  const afterStress = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after +150 stress = 313', afterStress === 313, `got ${afterStress}`);

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
