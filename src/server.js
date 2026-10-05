#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Portal } from './portal.js';

const portal = new Portal();
const serverInfo = { name: 'skolemelding-mcp', version: '0.2.0' };
const supportedVersions = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const tools = [
  { name: 'list_messages', description: 'List received Skolemelding messages with previews, unread state, and attachment names.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }, additionalProperties: false } },
  { name: 'get_message', description: 'Read full text and attachment metadata, including for unread messages, without changing their read status.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', pattern: '^\\d+$' } }, required: ['id'], additionalProperties: false } },
  { name: 'get_attachment', description: 'Get base64 bytes of a message attachment (maximum 10 MB).',
    inputSchema: { type: 'object', properties: { attachment_id: { type: 'string', pattern: '^\\d+:\\d+$' } }, required: ['attachment_id'], additionalProperties: false } },
];

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

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
      let value;
      if (params.name === 'list_messages') value = await portal.listMessages(args.limit);
      else if (params.name === 'get_message') value = await portal.getMessage(args.id);
      else if (params.name === 'get_attachment') value = await portal.getAttachment(args.attachment_id);
      else return error(id, -32602, `Unknown tool: ${params.name}`);
      result(id, { content: [{ type: 'text', text: JSON.stringify(value) }] });
    } else {
      error(id, -32601, `Method not found: ${method}`);
    }
  } catch (cause) {
    result(id, { content: [{ type: 'text', text: cause.message || String(cause) }], isError: true });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let request;
  try { request = JSON.parse(line); }
  catch { error(null, -32700, 'Invalid JSON'); continue; }
  await handle(request);
}
await portal.close();
