/**
 * Nightly audit — RPC error mapping, privacy boundary, bytecode/token
 * classification. Runs against the MOCK-RPC build:
 *   VITE_RPC_URL=http://127.0.0.1:5178/rpc npm run build
 *   OXL_E2E_PROFILE=.playwright-profile-mock node e2e/audit/rpc-privacy.mjs
 * Needs the fixture server (5173) and the mock RPC (5178) running.
 */
import { readFileSync } from 'node:fs';
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

  const errCode = async () => await card.errText();

  // ---- P-group: error mapping & privacy (address A43) ----------------------
  // (errors are never cached, so A43 can be reused across these)

  await mock.config([
    { id: 'http500', method: 'eth_getBalance', addrSub: ADDRS[43].toLowerCase(), action: 'status', value: 500 },
  ]);
  await card.hover(ADDRS[43]);
  await card.waitForCard('Lookup failed');
  check('R1 HTTP 500 → stable LOOKUP_FAILED', (await errCode()) === 'LOOKUP_FAILED',
    `code: ${await errCode()}`);
  await card.assertNoLeak('R1');
  await card.moveAway();

  await mock.config([
    { id: 'http429', method: 'eth_getBalance', addrSub: ADDRS[43].toLowerCase(), action: 'status', value: 429 },
  ]);
  await card.hover(ADDRS[43]);
  await card.waitForCard('Lookup failed');
  check('R2 HTTP 429 → stable LOOKUP_FAILED', (await errCode()) === 'LOOKUP_FAILED');
  await card.assertNoLeak('R2');
  await card.moveAway();

  await mock.config([
    { id: 'nonjson', method: 'eth_getBalance', addrSub: ADDRS[43].toLowerCase(), action: 'rawbody', value: '<html>gateway error</html>' },
  ]);
  await card.hover(ADDRS[43]);
  await card.waitForCard('Lookup failed');
  check('R3 non-JSON body → stable LOOKUP_FAILED', (await errCode()) === 'LOOKUP_FAILED');
  await card.assertNoLeak('R3');
  await card.moveAway();

  await mock.config([
    { id: 'rpcerr', method: 'eth_getBalance', addrSub: ADDRS[43].toLowerCase(), action: 'rpcerror', value: { code: -32000, message: 'limit exceeded for key demo-key-123 at https:// provider' } },
  ]);
  await card.hover(ADDRS[43]);
  await card.waitForCard('Lookup failed');
  check('R4 JSON-RPC error → stable LOOKUP_FAILED', (await errCode()) === 'LOOKUP_FAILED');
  const r4text = await card.assertNoLeak('R4');
  check('R4b raw provider message text absent from card',
    !r4text.includes('demo-key') && !r4text.includes('limit exceeded'));
  await card.moveAway();

  await mock.config([
    { id: 'hang', method: 'eth_getBalance', addrSub: ADDRS[43].toLowerCase(), action: 'hang' },
  ]);
  await card.hover(ADDRS[43]);
  await card.waitForCard('RPC timeout', 25000);
  check('R5 hung RPC → RPC_TIMEOUT (12s transport cap)', (await errCode()) === 'RPC_TIMEOUT');
  await card.assertNoLeak('R5');
  await card.moveAway();

  // ---- H-group: happy path + bytecode/token classification ----------------

  await mock.reset();
  await card.hover(ADDRS[43]);
  await card.waitForCard('NO ON-CHAIN FOOTPRINT');
  check('R6 default mock (empty EOA) → NO ON-CHAIN FOOTPRINT', true);
  await card.moveAway();

  // B1 plain EOA with balance → chip EOA
  await mock.config([
    { id: 'bal1', method: 'eth_getBalance', addrSub: ADDRS[1].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
  ]);
  await card.hover(ADDRS[1]);
  await card.waitForCard('EOA');
  check('B1 funded plain EOA → chip EOA', (await card.chipText()) === 'EOA');
  await card.moveAway();

  // B2 correct EIP-7702 designator → still EOA, delegate shown
  const delegate = ADDRS[5].toLowerCase().replace('0x', '');
  await mock.config([
    { id: 'bal2', method: 'eth_getBalance', addrSub: ADDRS[2].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code2', method: 'eth_getCode', addrSub: ADDRS[2].toLowerCase(), action: 'result', value: '0xef0100' + delegate },
  ]);
  await card.hover(ADDRS[2]);
  await card.waitForCard('7702');
  check('B2 7702 designator → chip EOA · 7702', (await card.chipText()) === 'EOA · 7702',
    `chip: ${await card.chipText()}`);
  check('B2b delegate target shown', ((await card.cardText()) ?? '').includes('0x' + delegate.slice(0, 4)));
  await card.moveAway();

  // B3 7702 prefix but wrong length → plain CONTRACT
  await mock.config([
    { id: 'bal3', method: 'eth_getBalance', addrSub: ADDRS[3].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code3', method: 'eth_getCode', addrSub: ADDRS[3].toLowerCase(), action: 'result', value: '0xef0100abcd' },
  ]);
  await card.hover(ADDRS[3]);
  await card.waitForCard('CONTRACT');
  check('B3 malformed 7702 (bad length) → CONTRACT', (await card.chipText()) === 'CONTRACT',
    `chip: ${await card.chipText()}`);
  await card.moveAway();

  // B4 plain contract code → CONTRACT
  await mock.config([
    { id: 'bal4', method: 'eth_getBalance', addrSub: ADDRS[5].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code4', method: 'eth_getCode', addrSub: ADDRS[5].toLowerCase(), action: 'result', value: '0x6080604052348015600f57600080fd5b50' },
  ]);
  await card.hover(ADDRS[5]);
  await card.waitForCard('CONTRACT');
  check('B4 plain contract bytecode → CONTRACT', (await card.chipText()) === 'CONTRACT');
  await card.moveAway();

  // B5 token metadata success → TOKEN chip with name · symbol
  await mock.config([
    { id: 'bal5', method: 'eth_getBalance', addrSub: ADDRS[6].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code5', method: 'eth_getCode', addrSub: ADDRS[6].toLowerCase(), action: 'result', value: '0x6080' },
    { id: 'tok5', method: 'eth_call', toSub: 'ca11bde05977b3631167028862be2a173976ca11', addrSub: ADDRS[6].toLowerCase(), action: 'multicall',
      value: { items: [{ ok: true, kind: 'string', value: 'Audit Token' }, { ok: true, kind: 'string', value: 'AUDT' }, { ok: true, kind: 'decimals', value: 6 }] } },
  ]);
  await card.hover(ADDRS[6]);
  await card.waitForCard('Audit Token');
  check('B5 token metadata → TOKEN chip', (await card.chipText()) === 'TOKEN');
  check('B5b name · symbol rendered', ((await card.cardText()) ?? '').includes('Audit Token · AUDT'));
  await card.moveAway();

  // B6 decimals out of range → metadata rejected → CONTRACT
  await mock.config([
    { id: 'bal6', method: 'eth_getBalance', addrSub: ADDRS[7].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code6', method: 'eth_getCode', addrSub: ADDRS[7].toLowerCase(), action: 'result', value: '0x6080' },
    { id: 'tok6', method: 'eth_call', toSub: 'ca11bde05977b3631167028862be2a173976ca11', addrSub: ADDRS[7].toLowerCase(), action: 'multicall',
      value: { items: [{ ok: true, kind: 'string', value: 'Absurd' }, { ok: true, kind: 'string', value: 'ABS' }, { ok: true, kind: 'decimals', value: 40 }] } },
  ]);
  await card.hover(ADDRS[7]);
  await card.waitForCard('CONTRACT');
  check('B6 decimals 40 → garbage filter → CONTRACT', (await card.chipText()) === 'CONTRACT');
  await card.moveAway();

  // B7 oversized name string → garbage filter → CONTRACT
  await mock.config([
    { id: 'bal7', method: 'eth_getBalance', addrSub: ADDRS[8].toLowerCase(), action: 'result', value: '0xde0b6b3a7640000' },
    { id: 'code7', method: 'eth_getCode', addrSub: ADDRS[8].toLowerCase(), action: 'result', value: '0x6080' },
    { id: 'tok7', method: 'eth_call', toSub: 'ca11bde05977b3631167028862be2a173976ca11', addrSub: ADDRS[8].toLowerCase(), action: 'multicall',
      value: { items: [{ ok: true, kind: 'string', value: 'X'.repeat(100) }, { ok: true, kind: 'string', value: 'LONG' }, { ok: true, kind: 'decimals', value: 18 }] } },
  ]);
  await card.hover(ADDRS[8]);
  await card.waitForCard('CONTRACT');
  check('B7 100-char name → garbage filter → CONTRACT', (await card.chipText()) === 'CONTRACT');
  await card.moveAway();

  // B8 huge balance formats without float damage
  const huge = '0x' + (1n << 200n).toString(16);
  await mock.config([
    { id: 'bal8', method: 'eth_getBalance', addrSub: ADDRS[9].toLowerCase(), action: 'result', value: huge },
  ]);
  await card.hover(ADDRS[9]);
  await card.waitForCard('BALANCE');
  const b8text = (await card.cardText()) ?? '';
  check('B8 2^200 wei balance renders integer string', /BALANCE/.test(b8text) &&
    !/NaN|undefined|Infinity|e\+/i.test(b8text), b8text.match(/BALANCE\s*[\d.,]+/)?.[0]);

  // ---- E-group: ENS paths --------------------------------------------------

  await mock.reset();
  await card.moveAway();
  // d19 name: no rules → universal resolver returns empty → unregistered
  await card.hoverEns('definitely-not-registered-audit.eth');
  await card.waitForCard('UNREGISTERED NAME');
  check('R7 unregistered name → UNREGISTERED NAME (empty resolver)', true);
  await card.moveAway();

  await mock.config([
    { id: 'resolvererr', method: 'eth_call', addrSub: 'eeeeeeee14d718c2', action: 'rpcerror', value: { code: -32000, message: 'resolver busted' } },
  ]);
  await card.hoverEns('mock-audit-name.eth');
  await card.waitForCard('Lookup failed');
  check('R8 resolver error → LOOKUP_FAILED', (await errCode()) === 'LOOKUP_FAILED');
  await card.assertNoLeak('R8');
  await card.moveAway();

  // CCIP-Read must stay OFF: an OffchainLookup error must surface as
  // LOOKUP_FAILED and NEVER trigger a gateway fetch.
  await mock.config([
    { id: 'ccip', method: 'eth_call', addrSub: 'eeeeeeee14d718c2', action: 'offchainLookup',
      value: 'http://127.0.0.1:5178/gateway/{data}' },
  ]);
  await card.hoverEns('mock-audit-name.eth');
  await card.waitForCard('Lookup failed');
  check('R9 OffchainLookup → LOOKUP_FAILED (no gateway chase)', (await errCode()) === 'LOOKUP_FAILED');
  const log = await mock.log();
  check('R9b zero gateway fetches (ccipRead mechanically off)', log.gatewayHits === 0,
    `gatewayHits=${log.gatewayHits}`);
  await card.moveAway();

  // ---- V-group: mechanical privacy/permission checks ------------------------

  const manifest = JSON.parse(readFileSync('.output/chrome-mv3/manifest.json', 'utf8'));
  check('V1 host_permissions = exactly the mock RPC origin',
    JSON.stringify(manifest.host_permissions) === JSON.stringify(['http://127.0.0.1:5178/*']),
    JSON.stringify(manifest.host_permissions));
  check('V1b no tabs/scripting permissions',
    !manifest.permissions.includes('tabs') && !manifest.permissions.includes('scripting'));

  const worker = ctx.serviceWorkers()[0];
  const blocked = await worker.evaluate(() =>
    fetch('https://example.com/.well-known/does-not-exist')
      .then(() => 'ALLOWED — PRIVACY BUG')
      .catch((e) => String(e.message ?? e)));
  check('V2 SW fetch to non-RPC origin rejected by whitelist guard',
    blocked.includes('blocked'), blocked);
  const blocked2 = await worker.evaluate(() =>
    fetch('http://127.0.0.1:5179/')
      .then(() => 'ALLOWED — PRIVACY BUG')
      .catch((e) => String(e.message ?? e)));
  check('V2b SW fetch to a different localhost port also rejected',
    blocked2.includes('blocked'), blocked2);

  process.exitCode = (await finishSuite('rpc-privacy')) ? 0 : 1;
} finally {
  mock.stop();
  await ctx.close();
}
