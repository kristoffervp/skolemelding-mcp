import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

// The module reads the sign-in file path once when it is imported, so all tests share one temporary file.
const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
const authFile = join(directory, 'mobile-auth.json');
const lockFile = `${authFile}.lock`;
const previousPath = process.env.SKOLEMELDING_MOBILE_AUTH_FILE;
process.env.SKOLEMELDING_MOBILE_AUTH_FILE = authFile;
const { readMobileAuth, refreshMobileAuth, saveMobileAuth } = await import('../src/mobile-auth.js');
const previousFetch = globalThis.fetch;
const original = { accessToken: 'old-access', refreshToken: 'old-refresh', userName: 'test-user', expiresAt: 0 };

function tokenResponse() {
  return new Response(JSON.stringify({
    access_token: 'new-access', refresh_token: 'new-refresh', userName: 'test-user', expires_in: 1800,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
  globalThis.fetch = previousFetch;
  await rm(lockFile, { force: true });
  await rm(authFile, { force: true });
});

after(async () => {
  globalThis.fetch = previousFetch;
  if (previousPath === undefined) delete process.env.SKOLEMELDING_MOBILE_AUTH_FILE;
  else process.env.SKOLEMELDING_MOBILE_AUTH_FILE = previousPath;
  await rm(directory, { recursive: true, force: true });
});

test('rotating a refresh token is safe across simultaneous readers', async () => {
  await saveMobileAuth(original);
  let refreshCalls = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://portal.skoleplattform.no/token');
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'old-refresh');
    refreshCalls++;
    return tokenResponse();
  };
  const [first, second] = await Promise.all([refreshMobileAuth(original), refreshMobileAuth(original)]);
  assert.equal(refreshCalls, 1);
  assert.equal(first.refreshToken, 'new-refresh');
  assert.equal(second.refreshToken, 'new-refresh');
  assert.equal((await readMobileAuth()).refreshToken, 'new-refresh');
  if (process.platform !== 'win32') assert.equal((await stat(authFile)).mode & 0o777, 0o600);
});

test('sign-in requests refuse redirects', async () => {
  await saveMobileAuth(original);
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    return tokenResponse();
  };
  await refreshMobileAuth(original);
});

test('saving the sign-in replaces a symlink instead of writing through it', async () => {
  const target = join(directory, 'elsewhere.txt');
  await writeFile(target, 'keep');
  await symlink(target, authFile);
  try {
    await saveMobileAuth(original);
    assert.equal(await readFile(target, 'utf8'), 'keep');
    assert.equal((await lstat(authFile)).isSymbolicLink(), false);
    assert.equal((await readMobileAuth()).refreshToken, 'old-refresh');
  } finally {
    await rm(target, { force: true });
  }
});

test('an unreadable sign-in file gives an error that does not quote the file', async () => {
  await writeFile(authFile, 'OPENAI_API_KEY=secret\n');
  await assert.rejects(readMobileAuth(), (error) => {
    assert.match(error.message, /unreadable/);
    assert.doesNotMatch(error.message, /OPENAI|secret/);
    return true;
  });
});

test('refresh waits for a lock held elsewhere and never removes a lock it does not own', async () => {
  await saveMobileAuth(original);
  await writeFile(lockFile, 'another-process');
  setTimeout(() => unlink(lockFile).catch(() => {}), 300);
  globalThis.fetch = async () => {
    // Simulates another process taking over the lock while this refresh is running.
    await writeFile(lockFile, 'taken-over');
    return tokenResponse();
  };
  const started = Date.now();
  const refreshed = await refreshMobileAuth(original);
  assert.ok(Date.now() - started >= 250, 'refresh should wait for the other lock');
  assert.equal(refreshed.refreshToken, 'new-refresh');
  assert.equal(await readFile(lockFile, 'utf8'), 'taken-over');
});

test('a stale lock is removed', async () => {
  await saveMobileAuth(original);
  await writeFile(lockFile, 'crashed-process');
  const old = new Date(Date.now() - 120_000);
  await utimes(lockFile, old, old);
  globalThis.fetch = async () => tokenResponse();
  assert.equal((await refreshMobileAuth(original)).refreshToken, 'new-refresh');
  await assert.rejects(stat(lockFile), { code: 'ENOENT' });
});
