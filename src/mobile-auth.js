import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { browserChannel, loadPlaywright, mobileAuthFilePath, mobileProfilePath } from './browser.js';

const portalOrigin = 'https://portal.skoleplattform.no';
const clientId = 'd12dad8a-f092-4a96-8a37-371590825d22';
const redirectUri = 'com.cgi.oslomelding.foresatte://oauth';
const tokenClientId = 'consoleAPP';
const appVersion = '6.0.6';

async function jsonRequest(url, options) {
  let response;
  try { response = await fetch(url, { ...options, signal: AbortSignal.timeout(30_000) }); }
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
  const temporaryPath = `${mobileAuthFilePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(auth), { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, mobileAuthFilePath);
}

export async function readMobileAuth() {
  const auth = JSON.parse(await readFile(mobileAuthFilePath, 'utf8'));
  if (!auth.accessToken || !auth.refreshToken || !auth.userName) {
    throw new Error('Saved mobile sign-in is incomplete. Run npm run login:mobile again.');
  }
  return auth;
}

async function withAuthLock(action) {
  await mkdir(dirname(mobileAuthFilePath), { recursive: true, mode: 0o700 });
  const lockPath = `${mobileAuthFilePath}.lock`;
  let handle;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { handle = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - (await stat(lockPath)).mtimeMs > 90_000) await unlink(lockPath);
      } catch (checkError) {
        if (checkError.code !== 'ENOENT') throw checkError;
      }
      await delay(100);
    }
  }
  if (!handle) throw new Error('Skolemelding sign-in file is busy. Retry shortly.');
  try { return await action(); }
  finally {
    await handle.close();
    await unlink(lockPath);
  }
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
    if (!response.access_token) throw new Error('Skolemelding did not return a new access token. Run npm run login:mobile again.');
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
  const context = await chromium.launchPersistentContext(mobileProfilePath, {
    channel: browserChannel, headless: false, acceptDownloads: false,
    chromiumSandbox: true, viewport: { width: 1280, height: 960 },
  });
  try {
    const callback = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out after ten minutes. Run npm run login:mobile again.')), 600_000);
      const attach = (page) => page.on('request', (request) => {
        if (!request.url().startsWith(`${redirectUri}?`)) return;
        clearTimeout(timer);
        resolve(request.url());
      });
      context.on('page', attach);
      context.pages().forEach(attach);
    });
    const page = context.pages()[0] || await context.newPage();
    console.log(`Complete ID-porten sign-in in ${browserChannel === 'msedge' ? 'Microsoft Edge' : 'Google Chrome'}. The callback is captured automatically.`);
    page.goto(authorizeUrl.href, { timeout: 0 }).catch(() => {});
    const callbackUrl = new URL(await callback);
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
  } finally {
    await context.close();
  }
}
