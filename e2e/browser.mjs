/**
 * Shared e2e launcher: resolves playwright-core from the project when present
 * (playwright-core never auto-downloads browsers — local runs use the system
 * Edge channel), falling back to a global playwright install. CI installs
 * Playwright Chromium and selects it with OXL_E2E_BROWSER=chromium.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  ({ chromium } = require('D:/code/nvmmode/nvm/node_global/node_modules/@playwright/cli/node_modules/playwright'));
}

// e2e scripts assume cwd = project root.
export const ROOT = process.cwd().replace(/\\/g, '/');
export const EXT_PATH = `${ROOT}/.output/chrome-mv3`;
// Audit suites against a mock-RPC build isolate their profile so cached
// service workers from the public-RPC build can never leak between variants.
export const PROFILE = process.env.OXL_E2E_PROFILE ?? `${ROOT}/.playwright-profile`;

export async function launchExtension({ viewport, recordVideo } = {}) {
  const useBundledChromium = process.env.OXL_E2E_BROWSER === 'chromium';
  return chromium.launchPersistentContext(PROFILE, {
    headless: false, // extensions require headed mode
    // Chrome/Edge are convenient locally; CI uses Playwright's downloaded
    // Chromium under xvfb so the offline suite is reproducible on Linux.
    ...(useBundledChromium ? {} : { channel: 'msedge' }),
    reducedMotion: 'no-preference', // test the REAL acquire sequence
    ...(viewport ? { viewport } : {}),
    ...(recordVideo ? { recordVideo } : {}),
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
}
