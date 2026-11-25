import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

// Replaces fetch inside the server process: inbox searches are slow, attachments return fixed bytes.
const fakeNetwork = `
globalThis.fetch = async (url, options) => {
  const { pathname } = new URL(url);
  if (pathname === '/api/messagesearchmobile/') {
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (JSON.parse(options.body).SearchTerm === 'nothing') return Response.json({ TotalMatching: 0, Result: [] });
    return Response.json({ TotalMatching: 1, Result: [{ Id: 7, Header: 'Hi', Body: '<p>Hello</p>', OnBehalfOf: 'ada01',
      Timestamp: '2026-10-01T08:00:00', IsMessageSeen: false, IsFeedBackQuestion: true, QuestionText: 'Can Ada come?',
      IsFeedBackReadConfirmation: true,
      Threads: [{ ThreadId: 't1', TimeStamp: '2026-10-02T09:00:00', DisplayText: 'Reply', IsSeen: true, ThreadText: '<p>Yes</p>' }],
      Attachments: ['/globalassets/attachments/plan.pdf', '/globalassets/attachments/photo.png', '/globalassets/attachments/gone.pdf'] }] });
  }
  if (pathname === '/api/MyProfile/GetChildInfo') {
    return Response.json({ FirstName: 'Parent', ParentChildOptions: [{ FirstName: 'Ada', LastName: 'Hansen', SchoolName: 'Nordpolen skole', UserName: 'ada01' }] });
  }
  if (pathname.endsWith('/gone.pdf')) return new Response('<html>Forbidden</html>', { status: 403, headers: { 'Content-Type': 'text/html' } });
  if (pathname.startsWith('/globalassets/attachments/')) {
    return new Response('bytes', { headers: { 'Content-Type': pathname.endsWith('.png') ? 'image/png' : 'application/pdf' } });
  }
  return new Response('not stubbed', { status: 500 });
};`;

// Checks a value against the parts of JSON Schema the output schemas use.
function schemaErrors(schema, value, path = '$') {
  const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : value === null ? 'null' : typeof value;
  if (actual !== schema.type && !(schema.type === 'number' && actual === 'integer')) return [`${path} is ${actual}, not ${schema.type}`];
  const errors = [];
  if ('const' in schema && value !== schema.const) errors.push(`${path} is not ${schema.const}`);
  if (actual === 'array') value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, `${path}[${index}]`)));
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) errors.push(`${path}.${key} is missing`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...schemaErrors(schema.properties[key], item, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not in the schema`);
    }
  }
  return errors;
}

// Returns the structured result after checking it matches both the output schema and the text block.
function structuredResult(response, tool) {
  const { structuredContent, content } = response.result;
  assert.ok(structuredContent, `${tool.name} should return structuredContent`);
  assert.deepEqual(JSON.parse(content[0].text), structuredContent);
  assert.deepEqual(schemaErrors(tool.outputSchema, structuredContent), []);
  return structuredContent;
}

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
  // Sends a raw message whose reply is expected to carry id null.
  const send = (message) => new Promise((resolve) => {
    pending.set(null, resolve);
    child.stdin.write(JSON.stringify(message) + '\n');
  });
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  };
  return { call, send, order, stop };
}

test('MCP exposes only the four read tools and negotiates a protocol version', async () => {
  const server = startServer({
    env: { SKOLEMELDING_MOBILE_AUTH_FILE: join(tmpdir(), `skolemelding-mcp-missing-${process.pid}.json`), SKOLEMELDING_ALLOW_SEND: '' },
  });
  try {
    const initialized = await server.call('initialize', { protocolVersion: '2024-11-05' });
    assert.equal(initialized.result.protocolVersion, '2024-11-05');
    const listed = await server.call('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), [
      'list_children', 'list_messages', 'get_message', 'get_attachment',
    ]);
    for (const name of ['send_prepared', 'mark_read', 'prepare_absence']) {
      const called = await server.call('tools/call', { name, arguments: { confirmation_code: 'deadbeef', summary: 'x', message_id: '1', when: 'today' } });
      assert.match(called.error.message, /Unknown tool/, `${name} must not run without SKOLEMELDING_ALLOW_SEND=1`);
    }
    const [, listMessages, getMessage, getAttachment] = listed.result.tools;
    for (const tool of listed.result.tools) {
      assert.equal(tool.outputSchema.type, 'object', `${tool.name} should describe its result`);
    }
    assert.equal(listMessages.inputSchema.properties.child.type, 'string');
    for (const filter of ['unread_only', 'questions_only', 'absence_only']) {
      assert.equal(listMessages.inputSchema.properties[filter].type, 'boolean');
    }
    assert.equal(listMessages.inputSchema.properties.search.type, 'string');
    assert.equal(getMessage.inputSchema.properties.include_html.type, 'boolean');
    assert.equal(getAttachment.inputSchema.properties.include_content.type, 'boolean');
    const signedOut = await server.call('tools/call', { name: 'list_messages', arguments: {} });
    assert.equal(signedOut.result.isError, true);
    assert.match(signedOut.result.content[0].text, /npm run login first/);
    const unknown = await server.call('tools/call', { name: 'toString', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const arrayName = await server.call('tools/call', { name: ['list_children'], arguments: {} });
    assert.equal(arrayName.error.code, -32602);
    const badId = await server.send({ jsonrpc: '2.0', id: { nested: true }, method: 'ping' });
    assert.deepEqual(badId, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
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
    const tools = Object.fromEntries((await server.call('tools/list')).result.tools.map((tool) => [tool.name, tool]));
    const [listed] = await Promise.all([
      server.call('tools/call', { name: 'list_messages', arguments: {} }), server.call('ping'),
    ]);
    assert.deepEqual(server.order.slice(2), [4, 3], 'ping should answer before the slow list');
    const [first] = structuredResult(listed, tools.list_messages).messages;
    assert.deepEqual(first.children, ['Ada Hansen']);
    assert.equal(first.question, 'Can Ada come?');
    assert.equal(first.readConfirmationRequested, true);
    const children = await server.call('tools/call', { name: 'list_children', arguments: {} });
    assert.deepEqual(structuredResult(children, tools.list_children), { children: [{ name: 'Ada Hansen', school: 'Nordpolen skole' }] });
    const filtered = await server.call('tools/call', { name: 'list_messages', arguments: { child: 'ada' } });
    assert.equal(structuredResult(filtered, tools.list_messages).messages.length, 1);
    const searched = await server.call('tools/call', { name: 'list_messages', arguments: { search: 'nothing', unread_only: true } });
    assert.deepEqual(structuredResult(searched, tools.list_messages), { messages: [] });

    for (const include_html of [false, true]) {
      const read = await server.call('tools/call', { name: 'get_message', arguments: { id: '7', include_html } });
      const message = structuredResult(read, tools.get_message);
      assert.equal(message.bodyText, 'Hello');
      assert.equal(message.threads[0].text, 'Yes');
      assert.equal('bodyHtml' in message, include_html);
      assert.equal('html' in message.threads[0], include_html);
    }

    const pathOnly = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:0' } });
    assert.equal(pathOnly.result.content.length, 1);
    assert.equal(structuredResult(pathOnly, tools.get_attachment).path, join(directory, 'attachments', '7-0-plan.pdf'));

    const pdf = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:0', include_content: true } });
    assert.equal(structuredResult(pdf, tools.get_attachment).size, 5);
    const [, resource] = pdf.result.content;
    assert.equal(resource.type, 'resource');
    assert.equal(resource.resource.mimeType, 'application/pdf');
    assert.match(resource.resource.uri, /^file:\/\/.*7-0-plan\.pdf$/);
    assert.equal(Buffer.from(resource.resource.blob, 'base64').toString(), 'bytes');

    const png = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:1', include_content: true } });
    assert.deepEqual(png.result.content[1], { type: 'image', data: Buffer.from('bytes').toString('base64'), mimeType: 'image/png' });

    const gone = await server.call('tools/call', { name: 'get_attachment', arguments: { attachment_id: '7:2' } });
    assert.equal(gone.result.isError, true);
    assert.match(gone.result.content[0].text, /refused this attachment \(HTTP 403\)/);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('sending tools exist only with SKOLEMELDING_ALLOW_SEND=1, and only send_prepared can send', async () => {
  const server = startServer({ env: { SKOLEMELDING_MOBILE_AUTH_FILE: join(tmpdir(), `skolemelding-mcp-missing-${process.pid}.json`), SKOLEMELDING_ALLOW_SEND: '1' } });
  try {
    const listed = await server.call('tools/list');
    assert.deepEqual(listed.result.tools.map(({ name }) => name), ['list_children', 'list_messages', 'get_message', 'get_attachment',
      'list_recipients', 'prepare_reply', 'prepare_answer', 'prepare_read_confirmation', 'prepare_message', 'prepare_absence', 'mark_read', 'send_prepared']);
    for (const tool of listed.result.tools) assert.equal(tool.outputSchema.type, 'object', `${tool.name} should describe its result`);
    const send = listed.result.tools.at(-1);
    assert.deepEqual(send.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const tool of listed.result.tools.slice(5, 10)) assert.match(tool.description, /Sends nothing/);
    const unknownCode = await server.call('tools/call', { name: 'send_prepared', arguments: { confirmation_code: 'deadbeef' } });
    assert.equal(unknownCode.result.isError, true);
    assert.match(unknownCode.result.content[0].text, /Unknown or expired/);
  } finally {
    await server.stop();
  }
});

test('local file errors do not reveal paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  const server = startServer({ env: { SKOLEMELDING_MOBILE_AUTH_FILE: directory } });
  try {
    const failed = await server.call('tools/call', { name: 'list_children', arguments: {} });
    assert.equal(failed.result.isError, true);
    assert.equal('structuredContent' in failed.result, false);
    assert.equal(failed.result.content[0].text, 'Local file error (EISDIR).');
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('read tools are marked read-only, and an oversized request line is refused without stopping the server', async () => {
  const server = startServer({
    env: { SKOLEMELDING_MOBILE_AUTH_FILE: join(tmpdir(), `skolemelding-mcp-missing-${process.pid}.json`), SKOLEMELDING_ALLOW_SEND: '' },
  });
  try {
    const { result } = await server.call('tools/list');
    assert.ok(result.tools.every((tool) => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
    const refused = server.send({ jsonrpc: '2.0', id: 99, method: 'ping', params: { padding: 'x'.repeat(70_000) } });
    assert.equal((await refused).error.message, 'Request too large');
    assert.deepEqual((await server.call('ping')).result, {});
  } finally { await server.stop(); }
});

test('with elicitation, the parent and not the AI confirms mark_read in the client dialog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'skolemelding-mcp-test-'));
  const authFile = join(directory, 'mobile-auth.json');
  await writeFile(authFile, JSON.stringify({ accessToken: 'access', refreshToken: 'refresh', userName: 'user', expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
  const network = `
const marked = [];
globalThis.fetch = async (url) => {
  const { pathname } = new URL(url);
  if (pathname === '/Api/MessageSearch') return Response.json({ TotalMatching: 1, Result: [{ Id: 7, Header: 'Hi', From: 'Kari', OnBehalfOf: 'ada01', Threads: [] }] });
  if (pathname === '/api/MyProfile/GetChildInfo') return Response.json({ ParentChildOptions: [{ FirstName: 'Ada', LastName: 'Hansen', UserName: 'ada01' }] });
  if (pathname === '/api/message/MarkMessageRead') { process.stderr.write('MARKED\\n'); return new Response(''); }
  return new Response('not stubbed', { status: 500 });
};`;
  const child = spawn(process.execPath, [`--import=data:text/javascript,${encodeURIComponent(network)}`, 'src/server.js'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SKOLEMELDING_MOBILE_AUTH_FILE: authFile, SKOLEMELDING_DATA_DIR: directory, SKOLEMELDING_ALLOW_SEND: '1' } });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = [];
  let wake = () => {};
  createInterface({ input: child.stdout }).on('line', (line) => { lines.push(JSON.parse(line)); wake(); });
  const next = async (test) => { for (;;) { const found = lines.find(test); if (found) return found; await new Promise((r) => { wake = r; }); } };
  const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  try {
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: { elicitation: {} } } });
    await next((m) => m.id === 1);
    write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mark_read', arguments: { message_id: '7' } } });
    const ask = await next((m) => m.method === 'elicitation/create');
    assert.match(ask.params.message, /mark_read[\s\S]*subject: Hi/);
    assert.equal(stderr.includes('MARKED'), false, 'nothing happens before the parent answers');
    write({ jsonrpc: '2.0', id: ask.id, result: { action: 'decline' } });
    const declined = await next((m) => m.id === 2);
    assert.match(declined.result.content[0].text, /not confirmed/);
    write({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mark_read', arguments: { message_id: '7' } } });
    const cancelled = await next((m) => m.method === 'elicitation/create' && m.id !== ask.id);
    write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
    assert.match((await next((m) => m.id === 4)).result.content[0].text, /not confirmed/);
    write({ jsonrpc: '2.0', id: cancelled.id, result: { action: 'accept', content: { confirm: true } } });
    write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mark_read', arguments: { message_id: '7' } } });
    const again = await next((m) => m.method === 'elicitation/create' && m.id !== ask.id && m.id !== cancelled.id);
    assert.equal(stderr.includes('MARKED'), false, 'an answer after the client cancelled does nothing');
    write({ jsonrpc: '2.0', id: again.id, result: { action: 'accept', content: { confirm: true } } });
    const done = await next((m) => m.id === 3);
    assert.equal(done.result.structuredContent.markedRead, true);
    assert.equal(stderr.includes('MARKED'), true);
  } finally {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
