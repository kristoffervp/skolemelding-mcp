import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = resolve(process.env.SKOLEMELDING_DATA_DIR || join(projectRoot, '.data'));

export function loadPlaywright() {
  try { return require(process.env.SKOLEMELDING_PLAYWRIGHT_PATH || 'playwright'); }
  catch { throw new Error('Playwright is unavailable. Run npm install in the project folder.'); }
}

export function defaultBrowserChannel(platform = process.platform) {
  return platform === 'win32' ? 'msedge' : 'chrome';
}

export const browserChannel = process.env.SKOLEMELDING_BROWSER_CHANNEL || defaultBrowserChannel();
export const mobileAuthFilePath = resolve(process.env.SKOLEMELDING_MOBILE_AUTH_FILE || join(dataDir, 'mobile-auth.json'));
export const mobileProfilePath = resolve(process.env.SKOLEMELDING_MOBILE_PROFILE || join(dataDir, 'mobile-browser-profile'));
