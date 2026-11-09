import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { convert } from 'html-to-text';
import { attachmentDirPath } from './browser.js';
import { MobileClient } from './mobile-client.js';

const origin = 'https://portal.skoleplattform.no';
const pageSize = 15;
const maxPages = 100;
// Messages seen by a search are reused for this long, so read state can lag by up to five minutes.
const cacheTtl = 5 * 60_000;
const maxNameBytes = 200;

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

function truncateBytes(text, budget) {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    result += character;
  }
  return result;
}

function fileName(messageId, index, name) {
  const cleaned = name.toWellFormed().normalize('NFC').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
  let extension = extname(cleaned);
  if (Buffer.byteLength(extension) > 20) extension = '';
  const base = truncateBytes(cleaned.slice(0, cleaned.length - extension.length), maxNameBytes - Buffer.byteLength(extension));
  return `${messageId}-${index}-${base || 'attachment'}${extension}`;
}

async function writePrivateFile(path, bytes) {
  const temporaryPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function plainText(html) {
  return convert(html || '', { wordwrap: false })
    .replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
}

export class Portal {
  #mobile;
  #attachmentDir;
  #cache = new Map();
  #lookups = new Map();

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
    if (!this.#lookups.has(id)) {
      this.#lookups.set(id, this.#search({ id }).finally(() => this.#lookups.delete(id)));
    }
    const message = (await this.#lookups.get(id)).find((item) => String(item.Id) === id);
    if (!message) throw new Error('Message not found in the inbox.');
    return message;
  }

  #thread(thread, includeHtml) {
    const result = { id: String(thread.ThreadId ?? ''), date: thread.TimeStamp || '', label: thread.DisplayText || '',
      unread: thread.IsSeen === false, text: plainText(thread.ThreadText) };
    if (includeHtml) result.html = thread.ThreadText || '';
    return result;
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
      result.threads = (Array.isArray(message.Threads) ? message.Threads : []).map((thread) => this.#thread(thread, includeHtml));
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
    const messageId = match[1];
    const index = Number(match[2]);
    const message = await this.#find(messageId);
    const path = Array.isArray(message.Attachments) ? message.Attachments[index] : undefined;
    const attachment = attachmentInfo(path, messageId, index);
    if (!attachment) throw new Error('Attachment not found.');
    const { bytes, mimeType } = await this.#mobile.getAttachment(attachment.url);
    await mkdir(this.#attachmentDir, { recursive: true, mode: 0o700 });
    const filePath = join(this.#attachmentDir, fileName(messageId, index, attachment.name));
    await writePrivateFile(filePath, bytes);
    const result = { id: attachmentId, name: attachment.name, mimeType, size: bytes.length, path: filePath };
    return includeContent ? { ...result, bytes } : result;
  }
}
