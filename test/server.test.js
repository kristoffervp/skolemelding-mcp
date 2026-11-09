import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

// Replaces fetch inside the server process: inbox searches are slow, attachments return fixed bytes.
const fakeNetwork = `
globalThis.fetch = async (url) => {
  const { pathname } = new URL(url);
  if (pathname === '/api/messagesearchmobile/') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return Response.json({ TotalMatching: 1, Result: [{ Id: 7, Header: 'Hi', Body: '<p>Hello</p>',
      Attachments: ['/globalassets/attachments/plan.pdf', '/globalassets/attachments/photo.png'] }] });
  }
  if (pathname.startsWith('/globalassets/attachments/')) {
    return new Response('bytes', { headers: { 'Content-Type': pathname.endsWith('.png') ? 'image/png' : 'application/pdf' } });
  }
  return new Response('not stubbed', { status: 500 });
};`;

function startServer({ env = {}, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, 'src/server.js'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const pending = new Map();
  const order = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const response = JSON.parse(line);
    order.push(response.id);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  };
  return { call, order, stop };
}

test('MCP exposes only the three read tools and negotiates a protocol version', async () => {
  const server = startServer({
    env: { SKOLEMELDING_MOBILE_AUTH_FILE: join(tmpdir(), `skolemelding-mcp-missing-${process.pid}.json`) },
  });
  try {
    const initialized = await server.call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.result.protocolVersion, '2024-11-05');
    const listed = await server.call('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      'list_messages', 'get_message', 'get_attachment',
    ]);
    const [, getMessage, getAttachment] = listed.result.tools;
    assert.equal(getMessage.inputSchema.properties.include_html.type, 'boolean');
    assert.equal(getAttachment.inputSchema.properties.include_content.type, 'boolean');
    const signedOut = await server.call('tools/call', { name: 'list_messages', arguments: {} });
    assert.equal(signedOut.result.isError, true);
    assert.match(signedOut.result.content[0].text, /npm run login first/);
    const unknown = await server.call('tools/call', { name: 'toString', arguments: {} });
    assert.equal(unknown.error.code, -32602);
  } finally {
    await server.stop();
  }
});

test('slow calls do not block ping, and attachment content uses MCP content types', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  const authFile = join(directory, 'mobile-auth.json');
  await writeFile(authFile, JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', userName: 'user',
    expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  const server = startServer({
    nodeArgs: [`--import=data:text/javascript,${encodeURIComponent(fakeNetwork)}`],
    env: { SKOLEMELDING_MOBILE_AUTH_FILE: authFile, SKOLEMELDING_ATTACHMENT_DIR: join(directory, 'attachments') },
  });
  try {
    await server.call('initialize', { protocolVersion: '2025-11-25' });
    const [listed] = await Promise.all([
      server.call('tools/call', { name: 'list_messages', arguments: {} }), server.call('ping'),
    ]);
    assert.deepEqual(server.order.slice(1), [3, 2], 'ping should answer before the slow list');
    assert.equal(JSON.parse(listed.result.content[0].text)[0].id, '7');

    const pathOnly = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:0' } });
    assert.equal(pathOnly.result.content.length, 1);
    assert.equal(JSON.parse(pathOnly.result.content[0].text).path, join(directory, 'attachments', '7-0-plan.pdf'));

    const pdf = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:0', include_content: true } });
    const [, resource] = pdf.result.content;
    assert.equal(resource.type, 'resource');
    assert.equal(resource.resource.mimeType, 'application/pdf');
    assert.match(resource.resource.uri, /^file:\/\/.*7-0-plan\.pdf$/);
    assert.equal(Buffer.from(resource.resource.blob, 'base64').toString(), 'bytes');

    const png = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:1', include_content: true } });
    assert.deepEqual(png.result.content[1], { type: 'image', data: Buffer.from('bytes').toString('base64'), mimeType: 'image/png' });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
