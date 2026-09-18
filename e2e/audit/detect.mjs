/**
 * Nightly audit — detection matrix (offline).
 * Hypotheses S-D1..S-D20: the scanner detects every supported address/ENS
 * form exactly once and never mis-detects the documented negatives.
 *   node e2e/audit/detect.mjs   (needs fixture server + built extension)
 */
import { launchExtension } from '../browser.mjs';
import { check, finish, openAuditedPage, countHl } from './helpers.mjs';

const URL = 'http://localhost:5173/audit.html';
const ctx = await launchExtension();

try {
  const page = await openAuditedPage(ctx, URL);
  const A = await page.evaluate(() => window.__auditAddrs);

  // positives: exactly one box each. Boxes always carry the CHECKSUMMED
  // identity — lowercase/upper text must canonicalize to it.
  check('D1 all-lower text → checksummed identity once', (await countHl(page, A[1])) === 1);
  check('D2 all-upper text → checksummed identity once', (await countHl(page, A[2])) === 1);
  check('D3 checksummed address detected once', (await countHl(page, A[3])) === 1);
  check('D5 two addresses in one node → 2 boxes',
    (await countHl(page, A[5])) === 1 && (await countHl(page, A[6])) === 1);
  check('D6 adjacent comma-separated addresses → 2 boxes',
    (await countHl(page, A[7])) === 1 && (await countHl(page, A[8])) === 1);
  check('D7 punctuation-wrapped address → 1 box', (await countHl(page, A[9])) === 1);
  check('D8 newline-separated addresses → 2 boxes',
    (await countHl(page, A[17])) === 1 && (await countHl(page, A[18])) === 1);
  check('D9 wrapped address spans multiple boxes (multi-rect)',
    (await countHl(page, A[10])) >= 2, `got ${await countHl(page, A[10])}`);
  check('D10 truncated text recovered from matching href', (await countHl(page, A[11])) === 1);
  check('D13 multi-address href picks consistent one', (await countHl(page, A[15])) === 1);

  // negatives: zero boxes
  check('D4 broken-checksum address NOT highlighted', (await countHl(page, A[4])) === 0);
  check('D11 truncated prefix mismatch vs href NOT highlighted', (await countHl(page, A[36])) === 0);
  check('D12 truncated suffix mismatch vs href NOT highlighted',
    (await countHl(page, A[37])) === 0);
  check('D16 ENS name detected once', (await countHl(page, 'audit-name-one.eth')) === 1);
  check('D17 0x-prefixed label is a NAME once', (await countHl(page, '0xdeadbeef.eth')) === 1);
  check('D18 email domains NOT highlighted (any depth)', (await countHl(page, 'audited-email.eth')) === 0);
  check('D19 unregistered name still detected as match',
    (await countHl(page, 'definitely-not-registered-audit.eth')) === 1);
  check('D20 unicode/emoji ENS NOT highlighted (documented limitation)',
    (await countHl(page, 'example.eth')) === 0);

  // skipped containers: no highlight may exist for A19 planted in
  // script/style/noscript/template/textarea/input/contenteditable
  check('D21-23 script/style/noscript/template/textarea/input/contenteditable NOT scanned',
    (await countHl(page, A[19])) === 0);

  // hidden content: entry may exist but no box may be visible IN THE DETECT
  // SECTION (the same identity may be visible in the geometry probes).
  const d24visibleBoxes = await page.evaluate((a) => {
    const root = document.querySelector('[data-0x-lens-overlay]').shadowRoot;
    const region = document.getElementById('detect-root').getBoundingClientRect();
    return [...root.querySelectorAll(`.hl[data-address="${a}"]`)]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right > region.left && r.left < region.right &&
          r.bottom > region.top && r.top < region.bottom;
      }).length;
  }, A[20]);
  check('D24 hidden address shows no visible box', d24visibleBoxes === 0);

  // d25/d26: page completed scan with empty + huge text nodes present (no hang,
  // no crash) — openAuditedPage already waited for scan stats; check they ran.
  const stats = await page.evaluate(() =>
    JSON.parse(document.querySelector('[data-0x-lens-overlay]').dataset.scanStats));
  check('D25/26 scan completed over empty + 1MB text node', stats.textNodes > 20, JSON.stringify(stats));

  process.exitCode = (await finish('detect')) ? 0 : 1;
} finally {
  await ctx.close();
}
