/**
 * Phase 4 end-to-end verification: side panel handoff over the REAL gesture
 * path (real click → content script message → sidePanel.open in background).
 *
 * Two observability facts worked around here:
 * - playwright does not surface side-panel targets as Pages → panel OPENING is
 *   asserted via CDP Target.getTargets (the sidepanel.html target exists);
 * - the panel's DOM is asserted by opening the same sidepanel.html as a normal
 *   tab (chrome.tabs.create) — identical app code, identical storage watch.
 *
 * Prereqs: `npm run build`, fixture server running (`npm run fixture`).
 *   node e2e/panel.mjs
 */
import { getAddress } from 'viem';
import { launchExtension } from './browser.mjs';

const FIXTURE = 'http://localhost:5173/';

const VITALIK = getAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ctx = await launchExtension();

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(FIXTURE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  // Warm the SW + RPC connection once (see card.mjs for rationale).
  await ctx
    .serviceWorkers()[0]
    ?.evaluate(async () => {
      try {
        await fetch('https://ethereum.reth.rs/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }),
        });
      } catch {
        /* warmup best-effort */
      }
    });

  const hover = async (address) => {
    const c = await page.evaluate((a) => {
      const b = document
        .querySelector('[data-0x-lens-overlay]')
        .shadowRoot.querySelector(`.hl[data-address="${a}"]`)
        .getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, address);
    await page.mouse.move(c.x, c.y);
  };

  // --- 1. hover vitalik until the card is up --------------------------------
  await hover(VITALIK);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'vitalik.eth',
    { timeout: 45000, polling: 200 },
  );
  check('hover card ready', true);

  // --- 2. real click on OPEN LENS (the gesture path under test) -------------
  const btn = await page.evaluate(() => {
    const r = document
      .querySelector('[data-0x-lens-card]')
      .shadowRoot.querySelector('.oxl-open')
      .getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(btn.x, btn.y);

  // --- 3. panel target must exist (side panels are not playwright Pages) ----
  const cdp = await ctx.browser().newBrowserCDPSession();
  let opened = false;
  const openDeadline = Date.now() + 10000;
  while (Date.now() < openDeadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.some((t) => t.url.includes('sidepanel.html'))) {
      opened = true;
      break;
    }
    await page.waitForTimeout(250);
  }
  check('side panel opened via real click (gesture path)', opened);

  // --- 4. panel app DOM: same code opened as a tab ---------------------------
  const sw = ctx.serviceWorkers()[0];
  const tabPromise = ctx.waitForEvent('page', { timeout: 15000 });
  await sw.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') }));
  const panelApp = await tabPromise;
  await panelApp.waitForFunction(
    (needle) => document.body.textContent.includes(needle),
    'vitalik.eth',
    { timeout: 30000, polling: 200 },
  );
  check('panel app renders vitalik identity', true);
  const text = await panelApp.evaluate(() => document.body.textContent);
  check('panel app shows full address', text.includes(VITALIK));
  check('panel app has copy button', text.includes('COPY'));
  check(
    'panel app has Etherscan link',
    await panelApp.evaluate(() => !!document.querySelector('a[href*="etherscan.io/address"]')),
  );

  // --- 5. clicking ANOTHER address switches the app (storage watch) ----------
  await hover(USDC);
  await page.waitForTimeout(400);
  const usdc = await page.evaluate((a) => {
    const b = document
      .querySelector('[data-0x-lens-overlay]')
      .shadowRoot.querySelector(`.hl[data-address="${a}"]`)
      .getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, USDC);
  await page.mouse.click(usdc.x, usdc.y);
  await panelApp.waitForFunction(
    (needle) => document.body.textContent.includes(needle),
    'USD Coin',
    { timeout: 30000, polling: 200 },
  );
  check('clicking USDC switches panel app (storage watch)', true);

  await panelApp.screenshot({ path: 'e2e/panel.png' });
  check('panel screenshot saved', true, 'e2e/panel.png');

  // --- 6. SW-side handoff state + network guard -------------------------------
  // (WXT strips the 'session:' area prefix when writing → raw key 'lens:focus';
  //  the value is the typed identity object {kind, address|name})
  const focus = sw
    ? await sw.evaluate(async () => (await chrome.storage.session.get('lens:focus'))['lens:focus'])
    : null;
  check(
    'storage handoff (storage.session lens:focus) = USDC',
    focus?.kind === 'address' && focus.address === USDC,
    `got ${JSON.stringify(focus)}`,
  );

  // The SW's fetch guard must reject any non-RPC origin — the structural
  // enforcement of "the RPC endpoint is the only host we talk to".
  const guard = await sw.evaluate(async () => {
    try {
      await fetch('https://example.com/');
      return 'allowed';
    } catch (e) {
      return /blocked/i.test(String(e?.message)) ? 'blocked' : `other: ${String(e?.message).slice(0, 60)}`;
    }
  });
  check('SW fetch guard blocks non-RPC origins', guard === 'blocked', guard);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx.close();
}
