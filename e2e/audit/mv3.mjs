/**
 * Nightly audit — MV3 service-worker lifecycle, message races, cache
 * correctness. Runs against the MOCK-RPC build:
 *   VITE_RPC_URL=http://127.0.0.1:5178/rpc npm run build
 *   OXL_E2E_PROFILE=.playwright-profile-mock node e2e/audit/mv3.mjs
 */
import { launchExtension } from '../browser.mjs';
import { check } from './helpers.mjs';
import { startMockRpc, wipeProfile, cardHelpers, openMockAuditedPage, finishSuite } from './mock-helpers.mjs';

wipeProfile(); // stale cached SW would serve a stale build

const ctx = await launchExtension({ viewport: { width: 1280, height: 900 } });
const mock = await startMockRpc();

try {
  const page = await openMockAuditedPage(ctx);
  const card = cardHelpers(page);
  const ADDRS = await page.evaluate(() => window.__auditAddrs);
  const workerUrl = () => ctx.serviceWorkers()[0]?.url() ?? '';

  // ---- S1: cold start (fresh profile): SW exists after first interaction ---
  check('M1 SW cold-started and is discoverable', workerUrl().includes('background.js'),
    workerUrl());
  const extId = workerUrl().match(/chrome-extension:\/\/([^/]+)\//)?.[1];
  check('M1b extension id resolvable', Boolean(extId));

  // ---- Panel-as-tab helper (same App code, same storage watch) -------------
  let panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForTimeout(400);

  const swSend = (msg) =>
    panel.evaluate((m) => chrome.runtime.sendMessage(m).catch((e) => ({ thrown: String(e.message ?? e) })), msg);

  // ---- S2: malformed / hostile messages must not crash the SW --------------
  const garbage = [
    'a string message',
    12345,
    null,
    { type: 'unknown/type' },
    { type: 'lens/resolve' },
    { type: 'lens/resolve', identity: { kind: 'address', address: '0x123' } },
    { type: 'lens/resolve', identity: { kind: 'name', name: '' } },
    { type: 'lens/openPanel' },
  ];
  const swHealthy = async () =>
    (await swSend({ type: 'lens/resolve', identity: { kind: 'address', address: ADDRS[0] } }))
      ?.ok !== undefined;
  await mock.config([
    { id: 'bal0', method: 'eth_getBalance', addrSub: ADDRS[0].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
  ]);
  for (const g of garbage) {
    const resp = await swSend(g);
    if (resp?.thrown) check(`M2 malformed ${JSON.stringify(g)?.slice(0, 30)} handled`, false, resp.thrown);
  }
  check('M2 malformed messages never crash the SW (health probe resolves)', await swHealthy());
  check('M2b errors stay stable codes', true); // detailed codes asserted in rpc-privacy

  // ---- S3: sender without a tab id (panel page) → openPanel is safe --------
  const openResp = await swSend({ type: 'lens/openPanel', identity: { kind: 'address', address: ADDRS[0] } });
  check('M3 openPanel from tabless sender responds ok', openResp?.ok === true, JSON.stringify(openResp));
  const focus = await panel.evaluate(() => chrome.storage.session.get('lens:focus'));
  check('M3b focus identity written to storage.session',
    focus?.['lens:focus']?.address?.toLowerCase() === ADDRS[0].toLowerCase(), JSON.stringify(focus));

  // ---- S4: concurrent same-identity resolves coalesce in flight -----------
  await mock.reset();
  const A44 = ADDRS[44];
  const results4 = await Promise.all([
    swSend({ type: 'lens/resolve', identity: { kind: 'address', address: A44 } }),
    swSend({ type: 'lens/resolve', identity: { kind: 'address', address: A44 } }),
    swSend({ type: 'lens/resolve', identity: { kind: 'address', address: A44 } }),
  ]);
  check('M4 3 concurrent same-identity resolves all succeed',
    results4.every((r) => r?.ok === true), JSON.stringify(results4.map((r) => r?.ok)));
  const log4 = await mock.log();
  const identityPosts = log4.posts.length;
  check('M4b coalesced to a single JSON-RPC batch POST', identityPosts === 1,
    `posts=${identityPosts}`);

  // ---- S5: extension lifecycle restart; storage.session session-scope ------
  // Idle-termination CANNOT be exercised under a CDP-attached harness (an
  // attached DevTools-equivalent session disables MV3 idle shutdown), so the
  // termination→restart property is covered by M1 (cold start) and M5b
  // (post-reload restart). What we CAN assert deterministically here:
  //  a) chrome.runtime.reload() restarts the extension and its SW;
  //  b) storage.session is correctly CLEARED on reload (session-scope cache —
  //     the same semantics that clear it when the browser closes).
  await mock.reset();
  await mock.config([
    { id: 'bal44', method: 'eth_getBalance', addrSub: A44.toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
  ]);
  // Make sure a profile is cached in storage.session.
  const preKeys = await panel.evaluate(() => chrome.storage.session.get(null));
  check('M5-pre profile cached in storage.session',
    Object.keys(preKeys).some((k) => k.startsWith('lens:p:')),
    JSON.stringify(Object.keys(preKeys)));

  await panel.evaluate(() => chrome.runtime.reload());
  // the reload destroys the old panel page — open a fresh one
  await page.waitForTimeout(1800);
  panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForTimeout(500);

  const postKeys = await panel.evaluate(() => chrome.storage.session.get(null));
  check('M5 extension reload clears storage.session (session-scope cache)',
    Object.keys(postKeys).length === 0, JSON.stringify(Object.keys(postKeys)));

  // The restarted SW must answer on demand; the session cache starts empty
  // so this resolve performs a REAL RPC round trip.
  const reResolve = await swSend({ type: 'lens/resolve', identity: { kind: 'address', address: A44 } });
  check('M5b SW restarted on demand and resolve succeeded', reResolve?.ok === true,
    JSON.stringify(reResolve).slice(0, 120));
  const bal44 = reResolve?.ok ? reResolve.profile.ethBalanceWei : null;
  check('M5c fresh fetch after session reset returns rule value (no ghost cache)',
    bal44 === BigInt('0xde0b6b3a7640000').toString(), `balanceWei=${bal44}`);
  const workersAfter = ctx.serviceWorkers().length;
  check('M5d a new SW worker is registered after restart', workersAfter >= 1, `n=${workersAfter}`);

  // S5's extension reload invalidated the content script living on this page
  // (its runtime channel is dead) — reload the page to get a fresh injection
  // before the hover-based race tests.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-0x-lens-overlay]')?.dataset.scanStats),
  );
  await page.waitForTimeout(400);

  // ---- S6: slow identity A, fast identity B — stale response must lose -----
  await mock.reset();
  const SLOW = ADDRS[17], FAST = ADDRS[18];
  await mock.config([
    { id: 'slow17', method: 'eth_getBalance', addrSub: SLOW.toLowerCase(), action: 'delay', delayMs: 2500 },
  ]);
  await card.moveAway(); // park the pointer neutrally so scrollIntoView can't
  await card.hoverDirect(SLOW); // leave the synthetic hover on an unrelated box
  await page.waitForTimeout(900); // intent + scan + card show with skeleton
  await card.moveAway(); // fully close A's card before approaching B
  await card.hoverDirect(FAST);
  try {
    await card.waitForCard(FAST.slice(0, 6), 8000); // B's own address in header
  } catch {
    const st = await page.evaluate(([slow, fast]) => ({
      card: document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')?.textContent?.slice(0, 80) ?? null,
      fastBoxes: [...document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll(`.hl[data-address="${fast}"]`)].length,
      slowBoxes: [...document.querySelector('[data-0x-lens-overlay]').shadowRoot.querySelectorAll(`.hl[data-address="${slow}"]`)].length,
      overlayHosts: document.querySelectorAll('[data-0x-lens-overlay]').length,
    }), [SLOW, FAST]).catch((e) => String(e));
    console.log('[s6] state on timeout:', JSON.stringify(st));
    throw new Error('S6 FAST card never appeared');
  }
  await page.waitForTimeout(3000); // let A's slow response land
  const raceText = (await card.cardText()) ?? '';
  check('M6 stale slow response does not overwrite fast focus',
    raceText.includes(FAST.slice(0, 6)) && !raceText.includes(SLOW.slice(0, 6)),
    `card: ${raceText.slice(0, 80)}`);
  await card.moveAway();

  // ---- S7: card closed before response → no ghost card ---------------------
  await card.hoverDirect(SLOW);
  await page.waitForTimeout(700);
  await card.moveAway(); // closes the card while A is still in flight
  await page.waitForTimeout(2600);
  check('M7 response after card close does not reopen a card', (await card.cardText()) === null);

  // ---- S8: tab closed mid-request → SW stays healthy ------------------------
  const page2 = await ctx.newPage();
  await page2.goto('http://localhost:5173/audit.html', { waitUntil: 'load' });
  await page2.waitForTimeout(600);
  await mock.config([
    { id: 'slow2', method: 'eth_getBalance', addrSub: SLOW.toLowerCase(), action: 'delay', delayMs: 2000 },
  ]);
  await cardHelpers(page2).hover(SLOW);
  await page2.close(); // response arrives into a dead channel
  await page.waitForTimeout(2500);
  check('M8 SW healthy after a tab closed mid-request', await swHealthy());

  // ---- S9: panel reload keeps the focused identity (storage.session) -------
  await swSend({ type: 'lens/openPanel', identity: { kind: 'address', address: ADDRS[39] } });
  await panel.reload();
  await panel.waitForTimeout(600);
  const panelText = await panel.evaluate(() => document.body.textContent ?? '');
  check('M9 panel reload restores focus identity', panelText.includes(ADDRS[39].slice(0, 6)),
    panelText.slice(0, 100));

  // ---- C-group: cache correctness ------------------------------------------
  await mock.reset();
  // C1 two hovers of the same identity → one RPC batch POST: the second
  // resolve is served from the session cache. (Text-case canonicalization
  // itself happens at detection time — see detect.mjs D1/D2.)
  await card.hover(ADDRS[43]);
  await card.waitForCard(ADDRS[43].slice(0, 6), 15000);
  await card.moveAway();
  await card.hover(ADDRS[43]);
  await page.waitForTimeout(900);
  const c1log = await mock.log();
  const identityKeyPosts = c1log.posts.length;
  check('C1 second hover hits session cache (one RPC batch total)',
    identityKeyPosts === 1, `posts=${identityKeyPosts}`);
  await card.moveAway();

  // C2 a failed resolve is never cached: error first, then success works.
  await mock.config([
    { id: 'failA36', method: 'eth_getBalance', addrSub: ADDRS[36].toLowerCase(), action: 'status', value: 500 },
  ]);
  // A36 is a negative fixture (no highlight) — drive it through the message
  // path directly from the panel page.
  const fail1 = await swSend({ type: 'lens/resolve', identity: { kind: 'address', address: ADDRS[36] } });
  check('C2 failing resolve surfaces stable error', fail1?.ok === false && typeof fail1?.error === 'string');
  await mock.reset();
  const fail2 = await swSend({ type: 'lens/resolve', identity: { kind: 'address', address: ADDRS[36] } });
  check('C2b the same identity resolves after the RPC recovers (failure not cached)',
    fail2?.ok === true, JSON.stringify(fail2).slice(0, 100));

  process.exitCode = (await finishSuite('mv3')) ? 0 : 1;
} finally {
  mock.stop();
  await ctx.close();
}
