/** Shared helpers for the mock-RPC audit suites (rpc-privacy, mv3). */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { check, results, openAuditedPage } from './helpers.mjs';
import { PROFILE } from '../browser.mjs';

const MOCK_BASE = 'http://127.0.0.1:5178';

/**
 * Start the mock RPC server; returns { stop, config, reset, log }.
 * The caller MUST also wipe the extension profile before launching the
 * browser: persistent profiles cache old service workers (see CLAUDE.md),
 * which silently serves stale builds to these suites.
 */
export function wipeProfile() {
  rmSync(PROFILE, { recursive: true, force: true });
}

export async function startMockRpc() {
  const child = spawn(process.execPath, ['e2e/audit/mock-rpc-server.mjs'], {
    stdio: 'ignore',
    detached: false,
  });
  // wait for readiness
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${MOCK_BASE}/__log`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    async config(rules) {
      const res = await fetch(`${MOCK_BASE}/__config`, {
        method: 'POST',
        body: JSON.stringify({ rules }),
      });
      if (!res.ok) throw new Error(`mock /__config failed: ${res.status}`);
    },
    async reset() {
      await fetch(`${MOCK_BASE}/__reset`, { method: 'POST' });
    },
    async log() {
      return (await fetch(`${MOCK_BASE}/__log`)).json();
    },
    stop() {
      child.kill();
    },
  };
}

/** Reusable card interaction helpers bound to a page (card.mjs patterns). */
export function cardHelpers(page) {
  const hoverAddress = (address) =>
    page.evaluate((a) => {
      const root = document.querySelector('[data-0x-lens-overlay]')?.shadowRoot;
      const hl = root?.querySelector(`.hl[data-address="${a}"]`);
      if (!hl) return null;
      hl.scrollIntoView({ block: 'center' });
      const b = hl.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, address);

  const hoverName = (name) =>
    page.evaluate((n) => {
      const root = document.querySelector('[data-0x-lens-overlay]')?.shadowRoot;
      const hl = root?.querySelector(`.hl[data-name="${n}"]`);
      if (!hl) return null;
      hl.scrollIntoView({ block: 'center' });
      const b = hl.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, name);

  const cardText = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
          ?.textContent ?? null,
    );

  const chipText = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-chip')
          ?.textContent ?? null,
    );

  const errText = () =>
    page.evaluate(
      () =>
        document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-err')
          ?.textContent ?? null,
    );

  const waitForCard = (needle, timeout = 20000) =>
    page.waitForFunction(
      (n) =>
        document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card')
          ?.textContent.includes(n) ?? false,
      needle,
      { timeout, polling: 100 },
    );

  const waitCardGone = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-0x-lens-card]')?.shadowRoot?.querySelector('.oxl-card'),
      null,
      { timeout: 6000, polling: 80 },
    );

  const hover = async (address) => {
    const c = await hoverAddress(address);
    if (!c) throw new Error(`no highlight for ${address}`);
    await page.waitForTimeout(250);
    await page.mouse.move(c.x, c.y, { steps: 4 });
  };

  /** Single-hop variant: no intermediate mouseover targets, so the intent
   *  can never be stolen by a box the interpolated path happens to cross. */
  const hoverDirect = async (address) => {
    const c = await hoverAddress(address);
    if (!c) throw new Error(`no highlight for ${address}`);
    await page.waitForTimeout(400); // let scroll-settling + repositions finish
    await page.mouse.move(c.x, c.y, { steps: 1 });
  };

  const hoverEns = async (name) => {
    const c = await hoverName(name);
    if (!c) throw new Error(`no name highlight for ${name}`);
    await page.waitForTimeout(250);
    await page.mouse.move(c.x, c.y, { steps: 4 });
  };

  const moveAway = async () => {
    await page.mouse.move(8, 60, { steps: 4 });
    await waitCardGone();
  };

  /** Assert the visible card leaks no endpoint/URL/key material. */
  const assertNoLeak = async (name) => {
    const text = (await cardText()) ?? '';
    const leaks = ['http://', 'https://', '127.0.0.1:5178', 'reth.rs', 'apikey', 'api_key', 'v2/']
      .filter((n) => text.toLowerCase().includes(n));
    check(`${name}: card leaks no URL/endpoint/key material`, leaks.length === 0,
      leaks.length ? `found: ${leaks.join(',')}` : `text: ${JSON.stringify(text.slice(0, 120))}`);
    return text;
  };

  return { hoverAddress, hoverName, cardText, chipText, errText, waitForCard, waitCardGone, hover, hoverDirect, hoverEns, moveAway, assertNoLeak };
}

export async function openMockAuditedPage(ctx) {
  return openAuditedPage(ctx, 'http://localhost:5173/audit.html');
}

export function finishSuite(name) {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[${name}] ${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0;
}
