#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Portal } from './portal.js';

const portal = new Portal();
const serverInfo = { name: 'skolemelding-mcp', version: '0.4.0' };
const supportedVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const tools = [
  { name: 'list_children', description: 'List the children on this Skolemelding account with their school.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_messages', description: 'List received Skolemelding messages with previews, unread state, attachment names, and which children each message is about. Set child to a first or full name from list_children to only list that child\'s messages.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, child: { type: 'string', minLength: 1 } }, additionalProperties: false } },
  { name: 'get_message', description: 'Read full text and attachment metadata, including for unread messages, without changing their read status. Set include_html to also get the original HTML body.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' }, include_html: { type: 'boolean', default: false } }, required: ['id'], additionalProperties: false } },
  { name: 'get_attachment', description: 'Save a message attachment (maximum 10 MB) to a local file and return its path, name, type, and size. Set include_content to also return the file itself as an image or embedded resource; do this if you cannot read local files.',
    inputSchema: { type: 'object', properties: { attachment_id: { type: 'string', pattern: '^\\d+:\\d+$' }, include_content: { type: 'boolean', default: false } }, required: ['attachment_id'], additionalProperties: false } },
];

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function json(value) { return [{ type: 'text', text: JSON.stringify(value) }]; }

const handlers = {
  list_children: async () => json(await portal.listChildren()),
  list_messages: async (args) => json(await portal.listMessages(args.limit, { child: args.child })),
  get_message: async (args) => json(await portal.getMessage(args.id, { includeHtml: args.include_html === true })),
  get_attachment: async (args) => {
    const { bytes, ...info } = await portal.getAttachment(args.attachment_id, { includeContent: args.include_content === true });
    const content = json(info);
    if (!bytes) return content;
    const data = bytes.toString('base64');
    if (imageTypes.has(info.mimeType)) content.push({ type: 'image', data, mimeType: info.mimeType });
    else content.push({ type: 'resource', resource: { uri: pathToFileURL(info.path).href, mimeType: info.mimeType, blob: data } });
    return content;
  },
};

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return error(request?.id ?? null, -32600, 'Invalid request');
  }
  const { id, method } = request;
  if (id === undefined) return;
  try {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    if (method === 'initialize') {
      const requestedVersion = params.protocolVersion;
      result(id, { protocolVersion: supportedVersions.has(requestedVersion) ? requestedVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo });
    } else if (method === 'ping') {
      result(id, {});
    } else if (method === 'tools/list') {
      result(id, { tools });
    } else if (method === 'tools/call') {
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const handler = Object.hasOwn(handlers, params.name) ? handlers[params.name] : undefined;
      if (!handler) return error(id, -32602, `Unknown tool: ${params.name}`);
      result(id, { content: await handler(args) });
    } else {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (cause) {
    result(id, { content: [{ type: 'text', text: cause.message || String(cause) }], isError: true });
  }
}

// Requests run concurrently so a slow inbox scan does not block ping or other calls.
const pending = new Set();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); }
  catch { error(null, -32700, 'Invalid JSON'); continue; }
  const task = handle(request).finally(() => pending.delete(task));
  pending.add(task);
}
await Promise.allSettled(pending);
await portal.close();
