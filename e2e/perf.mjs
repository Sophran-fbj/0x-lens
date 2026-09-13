/**
 * Phase 5 performance + real-site measurement.
 *
 * For each site: load it, wait for the initial scan, then read
 * `window.__oxlLensScan` (text nodes walked, matches, wall ms) plus a raw
 * count of 0x-address-shaped strings in visible text. raw >> highlighted on
 * a real site indicates either checksum failures or, on X, span-splitting.
 *
 * Prereqs: `npm run build`, fixture server for the first row.
 *   node e2e/perf.mjs
 */
import { launchExtension } from './browser.mjs';

const SITES = [
  { name: 'fixture (stress rig)', url: 'http://localhost:5173/' },
  { name: 'etherscan USDC token', url: 'https://etherscan.io/token/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  { name: 'wikipedia Ethereum', url: 'https://en.wikipedia.org/wiki/Ethereum' },
  { name: 'x.com vitalik (logged out)', url: 'https://x.com/vitalikbuterin' },
];

const ctx = await launchExtension();

const rows = [];
try {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const site of SITES) {
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // idle-scan + late content (SPA hydration, lazy rows)
      await page.waitForTimeout(6000);
      const r = await page.evaluate(() => {
        // Stats live on the overlay host (DOM bridges isolated/main worlds).
        const stats = JSON.parse(
          document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats ?? 'null',
        );
        const hl = document
          .querySelector('[data-0x-lens-overlay]')
          ?.shadowRoot?.querySelectorAll('.hl').length;
        const rawEls = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n = walker.nextNode();
        while (n && rawEls.length < 5) {
          if (/\b0x[a-fA-F0-9]{40}\b/.test(n.nodeValue ?? '')) {
            const el = n.parentElement;
            rawEls.push(`${el?.tagName}.${(el?.className ?? '').toString().slice(0, 40)}`);
          }
          n = walker.nextNode();
        }
        return { stats, hl, rawEls };
      });
      rows.push({ name: site.name, ...r });
      console.log(
        `${site.name.padEnd(28)} nodes=${String(r.stats?.textNodes ?? '?').padStart(6)}  ` +
          `matches=${String(r.stats?.matches ?? '?').padStart(4)}  ` +
          `hl=${String(r.hl ?? '?').padStart(4)}  ` +
          `${r.stats?.ms ?? '?'}ms  rawAt=${r.rawEls.slice(0, 2).join(' | ') || '-'}`,
      );
    } catch (err) {
      rows.push({ name: site.name, skipped: String(err).slice(0, 80) });
      console.log(`${site.name.padEnd(28)} SKIPPED — ${String(err).slice(0, 80)}`);
    }
  }
} finally {
  await ctx.close();
}

console.log('\nDONE');
process.exitCode = 0;
