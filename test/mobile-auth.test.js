import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('rotating a refresh token is safe across simultaneous readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  const previousPath = process.env.SKOLEMELDING_MOBILE_AUTH_FILE;
  const previousFetch = globalThis.fetch;
  process.env.SKOLEMELDING_MOBILE_AUTH_FILE = join(directory, 'mobile-auth.json');
  try {
    const { readMobileAuth, refreshMobileAuth, saveMobileAuth } = await import('../src/mobile-auth.js');
    const original = { accessToken: 'old-access', refreshToken: 'old-refresh', userName: 'test-user', expiresAt: 0 };
    await saveMobileAuth(original);
    let refreshCalls = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'https://portal.skoleplattform.no/token');
      const body = new URLSearchParams(options.body);
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'old-refresh');
      refreshCalls++;
      return new Response(JSON.stringify({
        access_token: 'new-access', refresh_token: 'new-refresh',
        userName: 'test-user', expires_in: 1800,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const [first, second] = await Promise.all([
      refreshMobileAuth(original), refreshMobileAuth(original),
    ]);
    assert.equal(refreshCalls, 1);
    assert.equal(first.refreshToken, 'new-refresh');
    assert.equal(second.refreshToken, 'new-refresh');
    assert.equal((await readMobileAuth()).refreshToken, 'new-refresh');
    if (process.platform !== 'win32') {
      assert.equal((await stat(process.env.SKOLEMELDING_MOBILE_AUTH_FILE)).mode & 0o777, 0o600);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPath === undefined) delete process.env.SKOLEMELDING_MOBILE_AUTH_FILE;
    else process.env.SKOLEMELDING_MOBILE_AUTH_FILE = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
