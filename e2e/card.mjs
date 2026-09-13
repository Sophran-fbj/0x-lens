/**
 * Phase 3 end-to-end verification: hover → acquire → card, over the REAL
 * message path (content script → background → mainnet RPC) in a real browser.
 *
 * Prereqs: `npm run build`, fixture server running (`npm run fixture`).
 *   node e2e/card.mjs
 */
import { getAddress } from 'viem';
import { launchExtension } from './browser.mjs';

const FIXTURE = 'http://localhost:5173/';

// Highlight boxes carry the EIP-55 checksummed address in data-address.
const VITALIK = getAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
const UNKNOWN = getAddress('0xabcdef0123456789abcdef0123456789abcdef01');

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

  // Warm the SW + RPC connection once: a cold service worker meeting a
  // slow-to-hang public RPC can stall the very first resolve for the full
  // test timeout. The tests assert OUR code, not today's routing weather.
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

  const hoverAddress = (address) =>
    page.evaluate((a) => {
      const root = document.querySelector('[data-0x-lens-overlay]')?.shadowRoot;
      const hl = root?.querySelector(`.hl[data-address="${a}"]`);
      if (!hl) return null;
      const b = hl.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, address);

  const cardText = () =>
    page.evaluate(() => {
      const host = document.querySelector('[data-0x-lens-card]');
      return host?.shadowRoot?.querySelector('.oxl-card')?.textContent ?? null;
    });

  const chipText = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-chip')
          ?.textContent ?? null,
    );

  const waitCardGone = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card'),
      null,
      { timeout: 5000, polling: 80 },
    );

  const hover = async (address) => {
    const c = await hoverAddress(address);
    if (!c) throw new Error(`no highlight found for ${address}`);
    await page.mouse.move(c.x, c.y);
  };

  const moveAway = async () => {
    await page.mouse.move(8, 300, { steps: 4 });
    await waitCardGone();
  };

  // 1. vitalik — full path: intent + scan + RPC resolve
  const t0 = Date.now();
  await hover(VITALIK);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'vitalik.eth',
    { timeout: 20000, polling: 100 },
  );
  const firstMs = Date.now() - t0;
  check('vitalik card shows ENS (full message path)', true, `${firstMs}ms incl. animation+RPC`);
  check(
    'vitalik chip = EOA (7702-aware)',
    (await chipText())?.startsWith('EOA') ?? false,
    `chip: ${await chipText()}`,
  );
  check('balance row rendered', ((await cardText()) ?? '').includes('BALANCE'));

  // 2. USDC — contract + token metadata wave
  await moveAway();
  await hover(USDC);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'USD Coin',
    { timeout: 20000, polling: 100 },
  );
  check('USDC card shows token metadata', true);
  check('USDC chip = TOKEN', (await chipText()) === 'TOKEN', `chip: ${await chipText()}`);

  // 3. unknown address — empty state
  await moveAway();
  await hover(UNKNOWN);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'NO ON-CHAIN FOOTPRINT',
    { timeout: 20000, polling: 100 },
  );
  check('unknown address → NO ON-CHAIN FOOTPRINT', true);

  // 4. second hover on vitalik — fast path (no scan ceremony)
  await moveAway();
  const t1 = Date.now();
  await hover(VITALIK);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'vitalik.eth',
    { timeout: 8000, polling: 50 },
  );
  const fastMs = Date.now() - t1;
  check('second hover resolves fast (cached, no scan)', fastMs < 2500, `${fastMs}ms`);

  // 5. scroll dismisses the card
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(400);
  check('scroll dismisses card', (await cardText()) === null);

  // 6. screenshot for the record (card open on vitalik)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  // Nudge the cursor first — after scrollTo(0,0) it sits at the same screen
  // coords, and a no-op mouse.move would fire no boundary events.
  await page.mouse.move(15, 350, { steps: 3 });
  await page.waitForTimeout(200);
  await hover(VITALIK);
  await page.waitForFunction(
    (needle) =>
      document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
        ?.textContent.includes(needle) ?? false,
    'vitalik.eth',
    { timeout: 8000, polling: 50 },
  );
  await page.screenshot({ path: 'e2e/card.png' });
  check('screenshot saved', true, 'e2e/card.png');

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await ctx.close();
}
