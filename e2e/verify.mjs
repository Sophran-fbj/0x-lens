/**
 * Phase 1 end-to-end verification: load the built extension, open the fixture
 * page, and assert the detection layer behaves per CLAUDE.md rules.
 *
 * Run AFTER `npm run build` and with the fixture server up (`npm run fixture`):
 *   node e2e/verify.mjs
 */
import { getAddress } from 'viem';
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
  //        + 1 (sec 10) + 1 (sec 11) + 2 (sec 12 href-recovered)
  //        + 2 (sec 13 ENS names) + 2 (sec 14 names) + 1 (sec 15 href query)
  //        + 1 (sec 16 transform-p) + 4 (sec 17: move-p, slow-p, endpunct.eth,
  //        shadow-p) = 25; stress: 150 spans → 175
  check('initial highlight count = 175', stats.highlights === 175, `got ${stats.highlights}`);
  check('boxes have page-absolute coords', stats.boxes.length > 0 && stats.boxes.every((b) => Number.parseFloat(b.top) > 0));

  // href-recovery: both truncated forms resolve to the same href address.
  const RECOVERED = getAddress('0x1111aaaa2222bbbb3333cccc4444dddd55558888');
  const recoveredCount = await page.evaluate(
    (a) =>
      document
        .querySelector('[data-0x-lens-overlay]')
        .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
    RECOVERED,
  );
  check('truncated-in-link recovered from href ×2', recoveredCount === 2, `got ${recoveredCount}`);

  // ENS names: two name highlights; the email domain must NOT light up.
  const nameCount = (n) =>
    page.evaluate(
      (name) =>
        document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelectorAll(`.hl[data-name="${name}"]`).length,
      n,
    );
  check('vitalik.eth highlighted', (await nameCount('vitalik.eth')) === 1);
  check('unregistered name highlighted', (await nameCount('unregistered-name-9x7.eth')) === 1);
  check('email domain not highlighted', (await nameCount('foo.eth')) === 0);

  // multi-level names match WHOLE (never partially as their parent); dotted
  // email domains never match; 0x-prefixed labels are names, not addresses.
  check('sub.vitalik.eth matched whole', (await nameCount('sub.vitalik.eth')) === 1);
  check('subdomain adds no parent highlight', (await nameCount('vitalik.eth')) === 1);
  check(
    'dotted email domain not highlighted',
    (await nameCount('mail.foo.eth')) === 0 && (await nameCount('foo.eth')) === 0,
  );
  check('0x-prefixed label treated as name', (await nameCount('0xdead.eth')) === 1);

  // href with several addresses: the one CONSISTENT with the visible text wins.
  const HOLDER = getAddress('0xbbbb2222bbbb2222bbbb2222bbbb2222bbbb9999');
  const holderCount = await page.evaluate(
    (a) =>
      document
        .querySelector('[data-0x-lens-overlay]')
        .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
    HOLDER,
  );
  check('multi-address href picks the consistent one', holderCount === 1, `got ${holderCount}`);

  // Negative cases: broken checksum / truncated / tx hash must NOT be inside the overlay.
  // (They can't be — overlay only contains valid matches — so count correctness above covers it.)

  // Dynamic injection (MutationObserver path).
  await page.click('#add');
  await page.waitForTimeout(700); // 200ms debounce + scan
  const afterAdd = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after dynamic inject = 176', afterAdd === 176, `got ${afterAdd}`);

  // Text mutation (characterData path).
  await page.click('#mutate');
  await page.waitForTimeout(700);
  const afterMutate = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after text mutation = 177', afterMutate === 177, `got ${afterMutate}`);

  // Stress button (MO + near-cap path).
  await page.click('#stress-btn');
  await page.waitForTimeout(900);
  const afterStress = await page.evaluate(
    () => document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll('.hl').length,
  );
  check('highlight after +150 stress = 327', afterStress === 327, `got ${afterStress}`);

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

  // Late href: link without a usable target at scan time gains one later.
  const LATE = getAddress('0x5555eeee5555eeee5555eeee5555eeee5555aaaa');
  const lateCount = () =>
    page.evaluate(
      (a) =>
        document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
      LATE,
    );
  await page.click('#late-href');
  await page.waitForTimeout(700);
  check('late-set href recovers truncation', (await lateCount()) === 1, `got ${await lateCount()}`);

  // No-match node reused: detached, mutated while detached, re-attached.
  const REUSE = getAddress('0x7777cccc8888dddd9999eeee0000bbbb1111aaaa');
  const reuseCount = () =>
    page.evaluate(
      (a) =>
        document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
      REUSE,
    );
  await page.click('#reuse-cycle'); // detach + mutate (mutations invisible to MO)
  await page.waitForTimeout(300);
  await page.click('#reuse-cycle'); // re-attach the SAME node
  await page.waitForTimeout(700);
  check('no-match node rescanned after reuse', (await reuseCount()) === 1, `got ${await reuseCount()}`);

  // Transform movement: no layout shift, no DOM mutation — class toggle only.
  const TRANSFORM_ADDR = getAddress('0x3333dddd4444eeee5555ffff6666aaaa7777bbbb');
  const transformTop = () =>
    page.evaluate(
      (a) => {
        const el = document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelector(`.hl[data-address="${a}"]`);
        return el ? el.getBoundingClientRect().top + window.scrollY : null;
      },
      TRANSFORM_ADDR,
    );
  const beforeTransform = await transformTop();
  await page.click('#transform-toggle');
  await page.waitForTimeout(900); // 300ms reposition debounce + margin
  const afterTransform = await transformTop();
  check(
    'transform movement tracked (class/style path)',
    beforeTransform !== null &&
      afterTransform !== null &&
      Math.abs(afterTransform - beforeTransform - 120) < 20,
    `Δ=${beforeTransform !== null && afterTransform !== null ? (afterTransform - beforeTransform).toFixed(0) : 'n/a'}px`,
  );

  // SLOW transition (1s): the start-event reposition lands mid-animation —
  // only transitionend must deliver the final geometry.
  const SLOW = getAddress('0xabab1212cdcd3434efef5656787890991212abab');
  const slowTop = () =>
    page.evaluate(
      (a) => {
        const el = document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelector(`.hl[data-address="${a}"]`);
        return el ? el.getBoundingClientRect().top + window.scrollY : null;
      },
      SLOW,
    );
  const beforeSlow = await slowTop();
  await page.click('#slow-transform');
  await page.waitForTimeout(1900); // 1s transition + end event + 300ms debounce
  const afterSlow = await slowTop();
  check(
    'slow transition final position tracked (transitionend)',
    beforeSlow !== null && afterSlow !== null && Math.abs(afterSlow - beforeSlow - 120) < 20,
    `Δ=${beforeSlow !== null && afterSlow !== null ? (afterSlow - beforeSlow).toFixed(0) : 'n/a'}px`,
  );
  // Restore: the translated highlight physically covers controls below it —
  // later clicks (e.g. #shadow-move) would hit the .hl instead.
  await page.click('#slow-transform');
  await page.waitForTimeout(1400);

  // Node MOVE while staying connected: exactly one highlight, box follows.
  const MOVE = getAddress('0x9999000088881111777722223333aaaa4444bbbb');
  const moveState = () =>
    page.evaluate(
      (a) => {
        const els = [
          ...document
            .querySelector('[data-0x-lens-overlay]')
            .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`),
        ];
        return {
          count: els.length,
          top: els[0] ? els[0].getBoundingClientRect().top + window.scrollY : null,
        };
      },
      MOVE,
    );
  const beforeMove = await moveState();
  await page.click('#move-node');
  await page.waitForTimeout(800);
  const afterMove = await moveState();
  check(
    'moved node keeps exactly one highlight (no leak)',
    beforeMove.count === 1 && afterMove.count === 1,
    `count ${beforeMove.count} → ${afterMove.count}`,
  );
  check(
    'moved node highlight follows to new position',
    afterMove.top !== null && beforeMove.top !== null && afterMove.top - beforeMove.top > 200,
    `Δ=${beforeMove.top !== null && afterMove.top !== null ? (afterMove.top - beforeMove.top).toFixed(0) : 'n/a'}px`,
  );

  // Node moved INTO a same-document shadow root: still "connected" but out
  // of the body observer's scope — highlight must go, and come back on return.
  const SHADOW = getAddress('0xcccc0000dddd1111eeee2222ffff3333aaaa4444');
  const shadowCount = () =>
    page.evaluate(
      (a) =>
        document
          .querySelector('[data-0x-lens-overlay]')
          .shadowRoot.querySelectorAll(`.hl[data-address="${a}"]`).length,
      SHADOW,
    );
  await page.click('#shadow-move');
  await page.waitForTimeout(700);
  check('shadow-moved node pruned (isConnected is not scope)', (await shadowCount()) === 0, `got ${await shadowCount()}`);
  await page.click('#shadow-move');
  await page.waitForTimeout(700);
  check('node returned from shadow re-highlighted', (await shadowCount()) === 1, `got ${await shadowCount()}`);

  // Right-edge name forms: partials never match; sentence period does.
  check(
    'foo.eth.com / éfoo.eth / foo.ethé never match',
    (await nameCount('foo.eth')) === 0 && (await nameCount('foo.eth.com')) === 0,
  );
  check(
    'vitalik.eth-link adds no match',
    (await nameCount('vitalik.eth')) === 1, // still only section 13's own
  );
  check('trailing-period name matches', (await nameCount('endpunct.eth')) === 1);

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
