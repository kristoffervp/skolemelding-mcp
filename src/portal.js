import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convert } from 'html-to-text';
import { attachmentDirPath } from './browser.js';
import { MobileClient } from './mobile-client.js';

const origin = 'https://portal.skoleplattform.no';
const pageSize = 15;
const maxPages = 100;
const cacheTtl = 5 * 60_000;

function attachmentInfo(path, messageId, index) {
  if (typeof path !== 'string') return null;
  let url;
  try { url = new URL(path, origin); }
  catch { return null; }
  if (url.origin !== origin || !url.pathname.startsWith('/globalassets/attachments/')) return null;
  let name;
  try { name = decodeURIComponent(url.pathname.split('/').pop()); }
  catch { name = url.pathname.split('/').pop(); }
  return { id: `${messageId}:${index}`, name, url: url.href };
}

function fileName(messageId, index, name) {
  const safe = name.replace(/[\u0000-\u001f/\\:]/g, '_').slice(0, 150) || 'attachment';
  return `${messageId}-${index}-${safe}`;
}

function plainText(html) {
  return convert(html || '', { wordwrap: false })
    .replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export class Portal {
  #mobile;
  #attachmentDir;
  #cache = new Map();

  constructor({ mobile = new MobileClient(), attachmentDir = attachmentDirPath } = {}) {
    this.#mobile = mobile;
    this.#attachmentDir = attachmentDir;
  }

  async close() {}

  #remember(messages) {
    const now = Date.now();
    for (const [id, entry] of this.#cache) if (now - entry.at >= cacheTtl) this.#cache.delete(id);
    for (const message of messages) this.#cache.set(String(message.Id), { message, at: now });
  }

  async #search({ id, limit = 30 } = {}) {
    const messages = [];
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.#mobile.searchPage(page, pageSize);
      messages.push(...payload.Result);
      this.#remember(payload.Result);
      if (id && messages.some((message) => String(message.Id) === id)) break;
      if (!id && messages.length >= limit) break;
      if (messages.length >= Number(payload.TotalMatching) || payload.Result.length < pageSize) break;
    }
    return messages;
  }

  async #find(id) {
    const entry = this.#cache.get(id);
    if (entry && Date.now() - entry.at < cacheTtl) return entry.message;
    const message = (await this.#search({ id })).find((item) => String(item.Id) === id);
    if (!message) throw new Error('Message not found in the inbox.');
    return message;
  }

  #normalize(message, { full = false, includeHtml = false } = {}) {
    const id = String(message.Id);
    const attachments = (Array.isArray(message.Attachments) ? message.Attachments : [])
      .map((path, index) => attachmentInfo(path, id, index)).filter(Boolean);
    const result = {
      id,
      subject: message.Header || '',
      sender: message.From || '',
      recipients: message.To || message.Receiver || '',
      date: message.Timestamp || '',
      unread: message.IsMessageSeen === false,
      attachmentNames: attachments.map(({ name }) => name),
    };
    if (full) {
      result.bodyText = plainText(message.Body);
      if (includeHtml) result.bodyHtml = message.Body || '';
      result.attachments = attachments.map(({ id: attachmentId, name }) => ({ id: attachmentId, name }));
      result.threads = message.Threads || [];
    } else {
      result.preview = message.SearchText || plainText(message.Body).slice(0, 240);
    }
    return result;
  }

  async listMessages(limit = 30) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be an integer from 1 to 100.');
    const messages = (await this.#search({ limit })).slice(0, limit);
    return messages.map((message) => this.#normalize(message));
  }

  async getMessage(id, { includeHtml = false } = {}) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid message ID.');
    return this.#normalize(await this.#find(id), { full: true, includeHtml });
  }

  async getAttachment(attachmentId, { includeContent = false } = {}) {
    const match = typeof attachmentId === 'string' && attachmentId.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error('Invalid attachment ID.');
    const [, messageId, index] = match;
    const message = await this.#find(messageId);
    const path = Array.isArray(message.Attachments) ? message.Attachments[Number(index)] : undefined;
    const attachment = attachmentInfo(path, messageId, Number(index));
    if (!attachment) throw new Error('Attachment not found.');
    const { bytes, mimeType } = await this.#mobile.getAttachment(attachment.url);
    await mkdir(this.#attachmentDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.#attachmentDir, fileName(messageId, index, attachment.name));
    await writeFile(filePath, bytes, { mode: 0o600 });
    const result = { id: attachmentId, name: attachment.name, mimeType, size: bytes.length, path: filePath };
    return includeContent ? { ...result, bytes } : result;
  }
}
