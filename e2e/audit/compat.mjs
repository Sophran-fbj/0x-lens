/**
 * Nightly audit — browser compatibility & security boundaries (offline).
 * Strict-CSP page, multi-iframe page (top-frame-only injection), closed
 * shadow root (documented limitation), chromium channel note (CI).
 *   node e2e/audit/compat.mjs   (needs fixture server + built extension)
 */
import { launchExtension } from '../browser.mjs';
import { check, finish, openAuditedPage, countHl } from './helpers.mjs';

const ctx = await launchExtension({ viewport: { width: 1280, height: 900 } });

try {
  // ---- C1: strict CSP page (script-src 'self' + style-src) -----------------
  // The extension must annotate without tripping CSP: no inline script, no
  // inline style beyond the shadow root's own <style> (exempt: constructed
  // inside the isolated shadow root, not subject to page CSP).
  const cspHtml = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'">
    </head><body>
    <p class="addr">strict CSP page: 0xBC8423D62000F83C1c887c945A267971E26F8772</p>
    <p>No inline handlers or remote resources here.</p>
    </body></html>`;
  await page_routeCsp(ctx, cspHtml);

  // ---- C2: iframes + closed shadow root ------------------------------------
  const page = await openAuditedPage(ctx, 'http://localhost:5173/audit-compat.html');

  const cspPage = ctx.pages().find((pg) => pg.url().startsWith('http://localhost:5173/csp'));
  void cspPage;

  // top frame highlighted
  check('C2 top-frame address highlighted', (await countHl(page, '0x95A05587Aea3452B18E91b96188E3D118aB8032d')) === 1);

  // iframes: no overlay hosts inside any frame; no highlight leakage
  const frames = page.frames().filter((fr) => fr !== page.mainFrame());
  check('C2b four child frames present', frames.length === 4, `frames=${frames.length}`);
  let leaked = 0;
  for (const fr of frames) {
    const r = await fr.evaluate(() => ({
      hosts: document.querySelectorAll('[data-0x-lens-overlay],[data-0x-lens-card]').length,
      addrPresent: /0x[a-fA-F0-9]{40}/.test(document.body?.textContent ?? ''),
    })).catch(() => null);
    if (!r || r.hosts > 0) leaked++;
    void r?.addrPresent;
  }
  check('C2c no extension overlay injected into iframes (top-frame only)', leaked === 0,
    `leaked frames=${leaked}`);

  // parent still annotates after iframe load churn
  check('C2d parent overlay healthy alongside iframes',
    (await countHl(page, '0x95A05587Aea3452B18E91b96188E3D118aB8032d')) === 1);

  // closed shadow root: content invisible to the scanner — the scan must
  // still COMPLETE (stats present, nodes walked) rather than crash midway.
  const scanOk = await page.evaluate(() => {
    const raw = document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats;
    if (!raw) return false;
    const s = JSON.parse(raw);
    return s.textNodes > 0;
  });
  check('C3 page with closed shadow root scanned without crash', scanOk);
  const closedVisible = await page.evaluate(() => {
    // the closed root is unreachable; its text exists only inside
    const host = document.getElementById('closed-host');
    return { shadowAccessible: Boolean(host.shadowRoot) };
  });
  check('C3b closed shadow root is indeed inaccessible (limitation documented)',
    closedVisible.shadowAccessible === false);
  check('C3c content after the closed root still highlighted',
    (await countHl(page, '0xc6EEBfA49C31358a741e725fF77FC50e0b84eEeB')) === 1,
    `got ${await countHl(page, '0xc6EEBfA49C31358a741e725fF77FC50e0b84eEeB')}`);

  process.exitCode = (await finish('compat')) ? 0 : 1;
} finally {
  await ctx.close();
}

/** Serve a strict-CSP page by intercepting a fake URL on the fixture origin. */
async function page_routeCsp(ctx, html) {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.route('**/csp-target', (route) =>
    route.fulfill({ body: html, contentType: 'text/html', status: 200 }));
  await page.goto('http://localhost:5173/csp-target', { waitUntil: 'load' });
  await page.waitForTimeout(1200); // scan settles
  const stats = await page.evaluate(() => {
    const host = document.querySelector('[data-0x-lens-overlay]');
    return {
      host: Boolean(host),
      stats: host?.dataset.scanStats ?? null,
      hl: host ? host.shadowRoot.querySelectorAll('.hl[data-address]').length : 0,
    };
  });
  check('C1 strict-CSP page: scanner injected and annotated', stats.hl === 1,
    `hl=${stats.hl} stats=${stats.stats}`);
}
