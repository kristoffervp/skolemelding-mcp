import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserChannel, loadPlaywright, mobileAuthFilePath } from './browser.js';
import { writePrivateFile } from './files.js';

const portalOrigin = 'https://portal.skoleplattform.no';
// Values used by the official Skolemelding Foresatte app. Override them if an app update makes the portal reject these.
const clientId = process.env.SKOLEMELDING_OIDC_CLIENT_ID || 'd12dad8a-f092-4a96-8a37-371590825d22';
const redirectUri = 'com.cgi.oslomelding.foresatte://oauth';
const tokenClientId = process.env.SKOLEMELDING_TOKEN_CLIENT_ID || 'consoleAPP';
const appVersion = process.env.SKOLEMELDING_APP_VERSION || '6.0.6';

export const outdatedHint = `If this keeps happening, the app version (${appVersion}) may be outdated; see SKOLEMELDING_APP_VERSION in the README.`;

async function jsonRequest(url, options) {
  let response;
  // Redirects are refused so that tokens and codes in the request body are never re-sent to another address.
  try { response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error('Could not reach the sign-in service. Check the network and retry.'); }
  if (!response.ok) {
    const error = new Error(`Sign-in service returned HTTP ${response.status}.`);
    error.httpStatus = response.status;
    throw error;
  }
  try { return await response.json(); }
  catch { throw new Error('Sign-in service returned an unexpected response.'); }
}

async function formPost(url, values) {
  return jsonRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(values),
  });
}

export async function saveMobileAuth(auth) {
  await mkdir(dirname(mobileAuthFilePath), { recursive: true, mode: 0o700 });
  await writePrivateFile(mobileAuthFilePath, JSON.stringify(auth));
}

export async function readMobileAuth() {
  const text = await readFile(mobileAuthFilePath, 'utf8');
  let auth;
  // The parse error would quote the start of the file, so it is replaced with a message that reveals nothing.
  try { auth = JSON.parse(text); }
  catch { throw new Error('Saved Skolemelding sign-in is unreadable. Run npm run login again.'); }
  if (!auth || !auth.accessToken || !auth.refreshToken || !auth.userName) {
    throw new Error('Saved mobile sign-in is incomplete. Run npm run login again.');
  }
  return auth;
}

async function removeLock(lockPath, owner) {
  try { if (await readFile(lockPath, 'utf8') === owner) await unlink(lockPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function removeStaleLock(lockPath) {
  try {
    const owner = await readFile(lockPath, 'utf8');
    if (Date.now() - (await stat(lockPath)).mtimeMs > 90_000) await removeLock(lockPath, owner);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Each holder writes its own token into the lock file and only removes a lock that still holds that token,
// so a process never removes a lock that another process has just taken.
async function withAuthLock(action) {
  await mkdir(dirname(mobileAuthFilePath), { recursive: true, mode: 0o700 });
  const lockPath = `${mobileAuthFilePath}.lock`;
  const owner = randomBytes(16).toString('hex');
  let locked = false;
  // Waits up to 45 seconds, longer than one sign-in request may take, before giving up.
  for (let attempt = 0; attempt < 450 && !locked; attempt++) {
    try {
      await writeFile(lockPath, owner, { flag: 'wx', mode: 0o600 });
      locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await removeStaleLock(lockPath);
      await delay(100);
    }
  }
  if (!locked) throw new Error('Skolemelding sign-in file is busy. Retry shortly.');
  try { return await action(); }
  finally { await removeLock(lockPath, owner); }
}

export async function refreshMobileAuth(auth, { preferProvided = false } = {}) {
  return withAuthLock(async () => {
    let current = auth;
    if (!preferProvided) {
      try {
        const saved = await readMobileAuth();
        if (saved.refreshToken !== auth.refreshToken && saved.expiresAt > Date.now() + 60_000) return saved;
        current = saved;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    const response = await formPost(`${portalOrigin}/token`, {
      grant_type: 'refresh_token', refresh_token: current.refreshToken,
      client_id: tokenClientId, app_version: appVersion, username: current.userName,
    });
    if (!response.access_token) throw new Error('Skolemelding did not return a new access token. Run npm run login again.');
    const updated = {
      ...current,
      accessToken: response.access_token,
      refreshToken: response.refresh_token || current.refreshToken,
      userName: response.userName || current.userName,
      expiresAt: Date.now() + Math.max(60, Number(response.expires_in) || 28 * 60) * 1000,
    };
    await saveMobileAuth(updated);
    return updated;
  });
}

export async function loginMobile() {
  const metadata = await jsonRequest('https://idporten.no/.well-known/openid-configuration');
  if (metadata.issuer !== 'https://idporten.no') throw new Error('Unexpected ID-porten issuer.');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const authorizeUrl = new URL(metadata.authorization_endpoint);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'openid profile', state, code_challenge: challenge,
    code_challenge_method: 'S256', ui_locales: 'nb', prompt: 'login',
  })) authorizeUrl.searchParams.set(key, value);

  const { chromium } = loadPlaywright();
  // A fresh browser profile is used for each sign-in and deleted afterwards, so no ID-porten session or saved
  // password is left on disk.
  const browser = await chromium.launch({ channel: browserChannel, headless: false, chromiumSandbox: true });
  let callbackUrl;
  try {
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 960 } });
    const callback = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out after ten minutes. Run npm run login again.')), 600_000);
      const closed = () => {
        clearTimeout(timer);
        reject(new Error('The sign-in window was closed before sign-in finished. Run npm run login again.'));
      };
      browser.on('disconnected', closed);
      context.on('page', (page) => {
        page.on('request', (request) => {
          if (!request.url().startsWith(`${redirectUri}?`)) return;
          clearTimeout(timer);
          browser.off('disconnected', closed);
          resolve(request.url());
        });
        page.on('close', () => { if (context.pages().length === 0) closed(); });
      });
    });
    const page = await context.newPage();
    console.log(`Complete ID-porten sign-in in ${browserChannel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}. The callback is captured automatically.`);
    page.goto(authorizeUrl.href, { timeout: 0 }).catch(() => {});
    callbackUrl = new URL(await callback);
  } finally {
    // Closing at once also dismisses any prompt to open the app's callback address in another program.
    await browser.close().catch(() => {});
  }
  if (callbackUrl.searchParams.get('state') !== state) throw new Error('Sign-in state mismatch. Please retry.');
  const code = callbackUrl.searchParams.get('code');
  if (!code) throw new Error('ID-porten did not return an authorization code.');
  const oidc = await formPost(metadata.token_endpoint, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: clientId, code_verifier: verifier,
  });
  if (!oidc.access_token) throw new Error('ID-porten did not return an access token.');
  const exchanged = await jsonRequest(`${portalOrigin}/api/exchange-app-token`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: oidc.access_token, provider: 'idporten' }),
  });
  if (!exchanged.authCode) throw new Error('Skolemelding did not accept the ID-porten sign-in.');
  const deviceId = randomUUID();
  const uniqueId = `${deviceId}|${Math.floor(Date.now() / 1000)}|Foresatte`;
  const mobile = await formPost(`${portalOrigin}/token`, {
    grant_type: 'password', username: exchanged.authCode, scope: uniqueId,
    client_id: tokenClientId, app_version: appVersion, password: 'code',
  });
  if (!mobile.access_token || !mobile.refresh_token || !mobile.userName) {
    throw new Error('Skolemelding did not return renewable credentials.');
  }
  const auth = {
    accessToken: mobile.access_token, refreshToken: mobile.refresh_token,
    userName: mobile.userName, deviceId,
    expiresAt: Date.now() + Math.max(60, Number(mobile.expires_in) || 28 * 60) * 1000,
  };
  await jsonRequest(`${portalOrigin}/api/deviceinfo/save`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ OsVersion: `${process.platform}|${release()}`, AppVersion: appVersion }),
  });
  await refreshMobileAuth(auth, { preferProvided: true });
  console.log(`Renewable Skolemelding sign-in saved at ${mobileAuthFilePath}.`);
}
