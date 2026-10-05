import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('MCP exposes only the three read tools and negotiates a protocol version', async () => {
  const child = spawn(process.execPath, ['src/server.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const input = createInterface({ input: child.stdout });
  const pending = new Map();
  input.on('line', (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  try {
    const initialized = await call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.result.protocolVersion, '2024-11-05');
    const listed = await call('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      'list_messages', 'get_message', 'get_attachment',
    ]);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  }
});
