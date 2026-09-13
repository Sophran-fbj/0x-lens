/**
 * Shared e2e launcher: resolves playwright-core from the project when present
 * (playwright-core never auto-downloads browsers — we use the system Edge
 * channel), falling back to a global playwright install.
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
export const PROFILE = `${ROOT}/.playwright-profile`;

export async function launchExtension({ viewport, recordVideo } = {}) {
  return chromium.launchPersistentContext(PROFILE, {
    headless: false, // extensions require headed mode
    channel: 'msedge', // system browser; no downloaded binaries needed
    reducedMotion: 'no-preference', // test the REAL acquire sequence
    ...(viewport ? { viewport } : {}),
    ...(recordVideo ? { recordVideo } : {}),
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
}
