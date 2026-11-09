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
  #children;

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

  async #search({ id, limit = 30, matches = () => true } = {}) {
    const messages = [];
    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.#mobile.searchPage(page, pageSize);
      messages.push(...payload.Result);
      this.#remember(payload.Result);
      if (id && messages.some((message) => String(message.Id) === id)) break;
      if (!id && messages.filter(matches).length >= limit) break;
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

  async #childList() {
    if (this.#children && Date.now() - this.#children.at < cacheTtl) return this.#children.list;
    const list = (await this.#mobile.getChildren())
      .filter((child) => child && child.UserName)
      .map((child) => {
        const firstNames = String(child.FirstName || '').trim();
        const lastName = String(child.LastName || '').trim();
        const givenName = firstNames.split(/\s+/)[0];
        const name = [firstNames, lastName].filter(Boolean).join(' ');
        // FirstName can include middle names, so also accept the first given name with or without the last name.
        const aliases = [name, firstNames, givenName, [givenName, lastName].filter(Boolean).join(' ')]
          .filter(Boolean).map((alias) => alias.toLocaleLowerCase('nb'));
        return { userName: String(child.UserName), name, school: child.SchoolName || '', aliases };
      });
    this.#children = { list, at: Date.now() };
    return list;
  }

  // Message annotations should not fail just because the child list is unavailable.
  async #childListOrEmpty() {
    try { return await this.#childList(); }
    catch { return []; }
  }

  #childUserNames(message) {
    const names = [message.OnBehalfOf, ...(Array.isArray(message.OnBehalfOfList) ? message.OnBehalfOfList : [])];
    return [...new Set(names.filter((name) => typeof name === 'string' && name))];
  }

  #thread(thread, includeHtml) {
    const result = { id: String(thread.ThreadId ?? ''), date: thread.TimeStamp || '', label: thread.DisplayText || '',
      unread: thread.IsSeen === false, text: plainText(thread.ThreadText) };
    if (includeHtml) result.html = thread.ThreadText || '';
    return result;
  }

  #normalize(message, { full = false, includeHtml = false, children = [] } = {}) {
    const id = String(message.Id);
    const attachments = (Array.isArray(message.Attachments) ? message.Attachments : [])
      .map((path, index) => attachmentInfo(path, id, index)).filter(Boolean);
    const result = {
      id,
      subject: message.Header || '',
      sender: message.From || '',
      children: this.#childUserNames(message)
        .map((userName) => children.find((child) => child.userName === userName)?.name).filter(Boolean),
      date: message.Timestamp || '',
      unread: message.IsMessageSeen === false,
      attachmentNames: attachments.map(({ name }) => name),
    };
    const recipients = message.To || message.Receiver;
    if (recipients) result.recipients = recipients;
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

  async listChildren() {
    return (await this.#childList()).map(({ name, school }) => ({ name, school }));
  }

  async #findChild(query) {
    const children = await this.#childList();
    const wanted = query.trim().replace(/\s+/g, ' ').toLocaleLowerCase('nb');
    const found = children.filter((child) => child.aliases.includes(wanted));
    const known = children.map(({ name }) => name).join(', ') || 'none';
    if (found.length === 0) throw new Error(`No child named "${query}" on this account. Children: ${known}.`);
    if (found.length > 1) throw new Error(`"${query}" matches more than one child. Use the full name: ${known}.`);
    return { child: found[0], children };
  }

  async listMessages(limit = 30, { child } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be an integer from 1 to 100.');
    if (child !== undefined && (typeof child !== 'string' || !child.trim())) throw new Error('Child must be a non-empty name.');
    let children;
    let matches = () => true;
    if (child === undefined) children = await this.#childListOrEmpty();
    else {
      const found = await this.#findChild(child);
      children = found.children;
      matches = (message) => this.#childUserNames(message).includes(found.child.userName);
    }
    const messages = (await this.#search({ limit, matches })).filter(matches).slice(0, limit);
    return messages.map((message) => this.#normalize(message, { children }));
  }

  async getMessage(id, { includeHtml = false } = {}) {
    if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Invalid message ID.');
    const [message, children] = await Promise.all([this.#find(id), this.#childListOrEmpty()]);
    return this.#normalize(message, { full: true, includeHtml, children });
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
