/**
 * Records the demo material: hover/acquire on the article fixture, then the
 * side panel app (opened as a tab — side panels are not recordable pages).
 * Two webm files land in e2e/video/; convert.mjs turns them into docs/demo.gif.
 *
 * Prereqs: `npm run build`, fixture server running (`npm run fixture`).
 *   node e2e/demo.mjs && node e2e/convert.mjs
 */
import { getAddress } from 'viem';
import { launchExtension } from './browser.mjs';

const ARTICLE = 'http://localhost:5173/article.html';

const VITALIK = getAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
const USDC = getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');

const ctx = await launchExtension({
  viewport: { width: 1080, height: 720 },
  recordVideo: { dir: 'e2e/video', size: { width: 1080, height: 720 } },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const centerOf = (page, address) =>
  page.evaluate((a) => {
    const b = document
      .querySelector('[data-0x-lens-overlay]')
      .shadowRoot.querySelector(`.hl[data-address="${a}"]`)
      .getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, address);
const glide = (page, to, ms) => page.mouse.move(to.x, to.y, { steps: Math.max(8, Math.round(ms / 40)) });

try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(ARTICLE, { waitUntil: 'load' });
  await sleep(2500);

  // 1. first hover: acquire sequence (glow → scan line → card → reveal)
  const v = await centerOf(page, VITALIK);
  await glide(page, v, 1400);
  await sleep(3200); // scan + card reveal + hold

  // 2. leave → card closes; come back → fast path
  await glide(page, { x: 80, y: 400 }, 900);
  await sleep(900);
  await glide(page, v, 900);
  await sleep(1800);

  // 3. OPEN LENS (opens the real side panel; panel content recorded next)
  const btn = await page.evaluate(() => {
    const r = document
      .querySelector('[data-0x-lens-card]')
      .shadowRoot.querySelector('.oxl-open')
      .getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await glide(page, btn, 700);
  await sleep(400);
  await page.mouse.click(btn.x, btn.y);
  await sleep(1500);

  // 4. panel app as a tab (same code as the side panel) — its own video track
  const sw = ctx.serviceWorkers()[0];
  const tabPromise = ctx.waitForEvent('page', { timeout: 15000 });
  await sw.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel.html') }));
  const panel = await tabPromise;
  await panel.setViewportSize({ width: 1080, height: 720 });
  await panel.waitForFunction(
    (needle) => document.body.textContent.includes(needle),
    'vitalik.eth',
    { timeout: 30000, polling: 200 },
  );
  await sleep(2000);

  // 5. copy interaction
  const copy = await panel.evaluate(() => {
    const b = document.querySelector('button[aria-label="Copy address"]').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  await panel.mouse.move(copy.x, copy.y, { steps: 10 });
  await sleep(300);
  await panel.mouse.click(copy.x, copy.y);
  await sleep(1500);

  // 6. switch to USDC via the article page (storage watch re-renders panel)
  const u = await centerOf(page, USDC);
  await page.bringToFront();
  await sleep(400);
  await glide(page, u, 1200);
  await sleep(2600); // card on USDC while panel (tab) re-renders in background
  await sleep(800);
} finally {
  await ctx.close(); // video files are written on close
}
console.log('videos saved to e2e/video/');
